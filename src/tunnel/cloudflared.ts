import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { SERVICE_NAME } from "../version.js";
import { findBinary } from "./detect.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
/** cloudflared's own registration API host — appears in log lines, is NOT a tunnel. */
const QUICK_TUNNEL_API_HOST_RE = /^https:\/\/api\.trycloudflare\.com$/i;

/** Extract a Quick Tunnel public URL from a cloudflared log line. */
export function parseQuickTunnelUrl(line: string): string | null {
  const match = line.match(QUICK_TUNNEL_URL_RE);
  if (!match) return null;
  if (QUICK_TUNNEL_API_HOST_RE.test(match[0])) return null;
  return match[0];
}

/**
 * Fail-closed startup (upstream #92): a URL in the log only means cloudflared
 * PRINTED a URL — the edge can still take a while to route, and a half-open
 * tunnel would send ChatGPT into the repair loop. The tunnel counts as
 * established only when its public /health identifies THIS service.
 */
export async function verifyTunnelServesHost(
  baseUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    try {
      const response = await doFetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { service?: string };
        if (body.service === SERVICE_NAME) return true;
      }
    } catch {
      // not reachable yet — the banner itself says it may take a while
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

/**
 * Cloudflare Quick Tunnel provider.
 * Quick Tunnels need no account/login; the URL changes on every start,
 * which the bridge and the Skill handle by reconfiguring automatically.
 */
export class CloudflaredQuickTunnel implements TunnelProvider {
  readonly name = "cloudflare-quick";
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly binaryOverride?: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.url) return this.url;
    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };
      const child = spawn(
        bin,
        ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
      );
      this.child = child;
      this.url = null;
      this.lastError = null;

      // Overall budget: 30s for the URL to appear + 30s for the public
      // health verification. /admin/tunnel/reload allows 90s.
      const VERIFY_TIMEOUT_MS = 30_000;
      const timeout = setTimeout(() => {
        if (!settled) {
          const message = "Quick tunnel did not produce a verified URL in time";
          this.lastError = message;
          this.logger.error(message);
          child.kill("SIGTERM");
          finish(() => reject(new Error(message)));
        }
      }, 30_000 + VERIFY_TIMEOUT_MS);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          const url = parseQuickTunnelUrl(line);
          if (url && !this.url && !settled) {
            this.url = url;
            this.logger.info(`Quick tunnel URL detected: ${url}; verifying it reaches this host...`);
            void verifyTunnelServesHost(url, { timeoutMs: VERIFY_TIMEOUT_MS, fetchImpl: this.fetchImpl }).then(
              (verified) => {
                if (settled) return;
                if (verified) {
                  this.logger.info(`Quick tunnel established: ${url}`);
                  finish(() => resolve(url));
                } else {
                  const message = `Public URL ${url} never reached this host's /health`;
                  this.lastError = message;
                  this.logger.error(message);
                  child.kill("SIGTERM");
                  finish(() => reject(new Error(message)));
                }
              }
            );
          }
          if (/error/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        this.child = null;
        finish(() => reject(error));
      });
      child.on("exit", (code) => {
        const wasUnverified = !settled;
        this.logger.warn(`cloudflared exited with code ${code}`);
        this.child = null;
        this.url = null;
        if (wasUnverified) {
          finish(() =>
            reject(
              new Error(
                `cloudflared exited (code ${code}) before establishing a tunnel${this.lastError ? `: ${this.lastError}` : ""}`
              )
            )
          );
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.url = null;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.url !== null,
      url: this.url,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("tunnel process not running");
    if (this.child && !this.url) problems.push("tunnel running but no public URL yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.url,
      problems,
    };
  }
}
