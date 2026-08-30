import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import { acquireTunnelOwnership, type TunnelClaim, type TunnelOwner } from "./ownership.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const CONNECTED_RE = /registered tunnel connection/i;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export interface CloudflaredNamedTunnelOptions {
  /** DNS hostname the fixed public URL routes on (the ownership claim key). */
  hostname: string;
  /** Tunnel name — display/fallback target when no UUID is available. */
  tunnelName?: string;
  /** Tunnel UUID — preferred run target when available. */
  tunnelId?: string;
  /**
   * Explicit tunnel credentials JSON. When set, cloudflared runs with
   * --credentials-file instead of relying on ~/.cloudflared state.
   */
  credentialsFile?: string;
  logger?: Logger;
  binaryOverride?: string;
  startTimeoutMs?: number;
  /**
   * Who is starting this tunnel (the bridge process). Identifies the claimant
   * for the machine-wide ownership claim; direct constructions default to the
   * current process.
   */
  owner?: TunnelOwner;
}

export function normalizeNamedTunnelHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_RE.test(normalized)) {
    throw new Error(`Invalid named tunnel hostname: ${hostname}`);
  }
  return normalized;
}

/** The cloudflared argv for one connector run (exported for tests). */
export function buildNamedRunArgs(opts: {
  target: string;
  localPort: number;
  credentialsFile?: string;
}): string[] {
  const args = ["tunnel", "--no-autoupdate"];
  if (opts.credentialsFile) args.push("--credentials-file", opts.credentialsFile);
  args.push("--url", `http://127.0.0.1:${opts.localPort}`, "run", opts.target);
  return args;
}

/**
 * Locally-managed Cloudflare named tunnel.
 *
 * The tunnel object and its DNS route are provisioned once with cloudflared.
 * This provider only starts and monitors the connector process, so the public
 * URL remains stable across bridge restarts.
 */
export class CloudflaredNamedTunnel implements TunnelProvider {
  readonly name = "cloudflare-named";
  private readonly hostname: string;
  private readonly tunnelName?: string;
  private readonly tunnelId?: string;
  private readonly credentialsFile?: string;
  private readonly logger: Logger;
  private readonly binaryOverride?: string;
  private readonly startTimeoutMs: number;
  private readonly owner: TunnelOwner;
  private child: ChildProcess | null = null;
  private connected = false;
  private lastError: string | null = null;
  private claim: TunnelClaim | null = null;

  constructor(opts: CloudflaredNamedTunnelOptions) {
    const hasName = typeof opts.tunnelName === "string" && opts.tunnelName.trim() !== "";
    const hasId = typeof opts.tunnelId === "string" && opts.tunnelId.trim() !== "";
    if (!hasName && !hasId) {
      throw new Error("A named tunnel needs a tunnelId or a tunnelName");
    }
    if (hasName && (opts.tunnelName as string).trim().length > 128) {
      throw new Error("Named tunnel name must be between 1 and 128 characters");
    }
    this.tunnelName = hasName ? (opts.tunnelName as string).trim() : undefined;
    this.tunnelId = hasId ? (opts.tunnelId as string).trim() : undefined;
    this.hostname = normalizeNamedTunnelHostname(opts.hostname);
    this.credentialsFile = opts.credentialsFile;
    this.logger = opts.logger ?? nullLogger;
    this.binaryOverride = opts.binaryOverride;
    this.startTimeoutMs = opts.startTimeoutMs ?? 45_000;
    this.owner = opts.owner ?? { pid: process.pid, workspaceId: "unknown" };
  }

  /** What cloudflared runs: the tunnel UUID when available, else the name. */
  private target(): string {
    return this.tunnelId ?? this.tunnelName ?? "";
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  private publicUrl(): string {
    return `https://${this.hostname}`;
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.connected) return this.publicUrl();
    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }
    if (this.credentialsFile && !fs.existsSync(this.credentialsFile)) {
      throw new Error(`Tunnel credentials file not found: ${this.credentialsFile}`);
    }
    // One connector per hostname per machine: two bridges running cloudflared
    // for the same hostname with different local ports would make Cloudflare
    // round-robin requests onto the wrong workspace (e.g. two workspaces
    // whose names slug to the same c2c-<name>.<zone>). The hostname — not the
    // tunnel name — is what DNS routes on, so that is what is claimed.
    if (!this.claim) {
      this.claim = acquireTunnelOwnership(this.hostname, this.owner, this.publicUrl());
    }
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        bin,
        buildNamedRunArgs({
          target: this.target(),
          localPort,
          credentialsFile: this.credentialsFile,
        }),
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
      );
      this.child = child;
      this.connected = false;
      this.lastError = null;
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };
      const timeout = setTimeout(() => {
        if (!this.connected) {
          this.lastError = "Named tunnel start timed out";
          child.kill("SIGTERM");
          finish(() => reject(new Error(this.lastError ?? "Named tunnel start timed out")));
        }
      }, this.startTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          if (CONNECTED_RE.test(line) && !this.connected) {
            this.connected = true;
            const url = this.publicUrl();
            this.logger.info(`Named tunnel established: ${url}`);
            finish(() => resolve(url));
          }
          if (/\b(error|failed|fatal)\b/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        this.child = null;
        this.connected = false;
        this.releaseClaim();
        finish(() => reject(error));
      });
      child.on("exit", (code) => {
        const wasStarting = !this.connected;
        this.logger.warn(`cloudflared named tunnel exited with code ${code}`);
        this.child = null;
        this.connected = false;
        // The connector is gone either way — free the machine-wide claim so
        // another workspace can take the hostname over.
        this.releaseClaim();
        if (wasStarting) {
          finish(() =>
            reject(
              new Error(
                `cloudflared exited (code ${code}) before establishing the named tunnel${
                  this.lastError ? `: ${this.lastError}` : ""
                }`
              )
            )
          );
        }
      });
    });
  }

  private releaseClaim(): void {
    this.claim?.release();
    this.claim = null;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child) {
      this.child = null;
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      child.kill("SIGTERM");
      // The claim must stay held until the connector can no longer route
      // traffic: releasing before the process actually exits would let
      // another workspace spawn a second connector for the same hostname
      // while this one is still up. Bound the graceful wait, then force-kill.
      const finished = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000).unref()),
      ]);
      if (!finished) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        await exited.catch(() => undefined);
      }
    }
    this.connected = false;
    this.releaseClaim();
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.connected,
      url: this.connected ? this.publicUrl() : null,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.connected ? this.publicUrl() : null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (this.credentialsFile && !fs.existsSync(this.credentialsFile)) {
      // Distinct from binary/connectivity problems: re-running Cloudflare
      // login does not fix a missing tunnel credential file.
      problems.push(`tunnel credentials file not found: ${this.credentialsFile}`);
    }
    if (bin && !this.child) problems.push("named tunnel process not running");
    if (this.child && !this.connected) problems.push("named tunnel is not connected yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null && this.connected,
      url: this.connected ? this.publicUrl() : null,
      problems,
    };
  }
}
