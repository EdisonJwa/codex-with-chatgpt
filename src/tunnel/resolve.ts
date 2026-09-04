import { createHash } from "node:crypto";
import { CloudflaredNamedTunnel } from "./cloudflared-named.js";
import { readMachineTunnel } from "./machine-config.js";
import { CloudflaredQuickTunnel } from "./cloudflared.js";
import { namedTunnelBinding, readTunnelState } from "./state.js";
import type { TunnelOwner } from "./ownership.js";
import type { TunnelProvider } from "./provider.js";
import type { Logger } from "../logger/index.js";

/**
 * Which configuration layer a workspace's tunnel comes from. The machine
 * override (tunnel.json) wins when present and valid; a malformed machine
 * config is a startup error, never a silent fallback to a rotating endpoint.
 */
export type TunnelSource = "machine" | "workspace" | "quick";

export interface EffectiveTunnelState {
  source: TunnelSource;
  /** Set when the machine override exists but is invalid — fail closed. */
  error?: string;
  /** Set for source "machine": the resolved fixed-address details. */
  machine?: {
    hostname: string;
    target: string;
    tunnelName?: string;
    tunnelId?: string;
    publicUrl: string;
    credentialsFile: string;
    /** Stable identity of THIS config (source+hostname+target+creds path). */
    configId: string;
  };
}

/**
 * Stable identity of a machine config, hashed from normalized non-secret
 * fields (never the credential contents). Bridges expose the id they were
 * started with, so doctor can tell "running bridge predates a config
 * change" even when both old and new configs are machine-mode.
 */
export function machineConfigId(m: {
  hostname: string;
  target: string;
  credentialsFile: string;
}): string {
  return createHash("sha256")
    .update(["machine", m.hostname, m.target, m.credentialsFile].join("|"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Inspect which tunnel layer is effective without constructing a provider.
 * Used by the CLI (status/doctor) and by the provider resolver below.
 */
export function effectiveTunnelState(workspaceId: string): EffectiveTunnelState {
  const machine = readMachineTunnel();
  if (machine.status === "malformed") {
    return { source: "machine", error: machine.error };
  }
  if (machine.status === "ok") {
    return {
      source: "machine",
      machine: {
        hostname: machine.resolved.hostname,
        target: machine.resolved.target,
        tunnelName: machine.resolved.tunnelName,
        tunnelId: machine.resolved.tunnelId,
        publicUrl: machine.resolved.publicUrl,
        credentialsFile: machine.resolved.credentialsFile,
        configId: machineConfigId(machine.resolved),
      },
    };
  }
  if (namedTunnelBinding(readTunnelState(workspaceId))) {
    return { source: "workspace" };
  }
  return { source: "quick" };
}

/**
 * Build the provider a workspace bridge should use. Throws when the machine
 * override exists but is malformed — the user asked for a fixed address and
 * must learn when it cannot be used, rather than silently rotating URLs.
 */
export function resolveTunnelProvider(
  workspaceId: string,
  logger: Logger,
  owner?: TunnelOwner
): { source: TunnelSource; provider: TunnelProvider; configId?: string } {
  const effective = effectiveTunnelState(workspaceId);
  if (effective.source === "machine" && effective.error) {
    throw new Error(effective.error);
  }
  if (effective.source === "machine" && effective.machine) {
    const machine = effective.machine;
    return {
      source: "machine",
      configId: machine.configId,
      provider: new CloudflaredNamedTunnel({
        hostname: machine.hostname,
        tunnelId: machine.tunnelId,
        tunnelName: machine.tunnelName,
        credentialsFile: machine.credentialsFile,
        logger,
        owner: owner ?? { pid: process.pid, workspaceId },
      }),
    };
  }
  if (effective.source === "workspace") {
    const binding = namedTunnelBinding(readTunnelState(workspaceId))!;
    return {
      source: "workspace",
      configId: `workspace:${workspaceId}`,
      provider: new CloudflaredNamedTunnel({
        hostname: binding.hostname,
        tunnelName: binding.tunnelName,
        tunnelId: binding.tunnelId,
        logger,
        owner: owner ?? { pid: process.pid, workspaceId },
      }),
    };
  }
  return { source: "quick", configId: "quick", provider: new CloudflaredQuickTunnel(logger) };
}

/**
 * The doctor tunnel decision, factored out as a pure function so the
 * ordering — reconciliation BEFORE generic reachability — is unit-testable:
 * a healthy old tunnel must stay red when the effective machine config
 * differs, and `fix` turns that red into a restart (re-evaluated after).
 *
 * `loginRepair` is true ONLY for a down per-workspace provisioned named
 * tunnel, where `cloudflared tunnel login` is the actual repair. Machine
 * mode (explicit credentials file) never routes into the login flow.
 */
export interface DoctorTunnelDecision {
  red: boolean;
  restart: boolean;
  detail?: string;
  loginRepair: boolean;
}

export function doctorTunnelDecision(opts: {
  effective: EffectiveTunnelState;
  running: RunningTunnelInfo | null;
  /** The running public URL is unreachable (or absent). */
  down: boolean;
  fix: boolean;
  namedReady: boolean;
}): DoctorTunnelDecision {
  const { effective, running, down, fix, namedReady } = opts;
  if (effective.source === "machine" && effective.error) {
    return { red: true, restart: false, detail: effective.error, loginRepair: false };
  }
  if (effective.source === "machine" && effective.machine) {
    const evaluation = running
      ? evaluateRunningTunnel(effective, running)
      : { ok: false as const, restart: false as const, detail: "bridge not running" };
    if (!evaluation.ok) {
      // With --fix a restart resolves it; without --fix it stays red.
      return {
        red: true,
        restart: Boolean(fix && evaluation.restart),
        detail: evaluation.detail,
        loginRepair: false,
      };
    }
    if (down) {
      // Config matches but the connector is down: starting it (or surfacing
      // the start error) is the repair — Cloudflare login is irrelevant.
      return {
        red: true,
        restart: false,
        detail: running?.detail ?? `machine tunnel ${effective.machine.hostname} is down`,
        loginRepair: false,
      };
    }
    return { red: false, restart: false, loginRepair: false };
  }
  if (namedReady) {
    // Per-workspace provisioned named mode: a down tunnel IS repaired by a
    // Cloudflare login (cert.pem may be missing or stale).
    return {
      red: Boolean(down || !running),
      restart: false,
      detail: "NAMED_TUNNEL_DOWN",
      loginRepair: Boolean(down || !running),
    };
  }
  return { red: false, restart: false, loginRepair: false };
}

/** The minimal view of a RUNNING bridge needed to reconcile it. */
export interface RunningTunnelInfo {
  provider: string;
  tunnelSource?: string;
  tunnelConfigId?: string;
  url?: string | null;
  /** The provider's last error, if the connector reported one. */
  detail?: string;
}

/**
 * Pure reconciliation decision: does the running bridge match the effective
 * tunnel configuration? Machine overrides are matched by config identity and
 * by the actual public URL — a healthy tunnel serving the WRONG address is
 * still wrong.
 */
export function evaluateRunningTunnel(
  effective: EffectiveTunnelState,
  running: RunningTunnelInfo
): { ok: boolean; restart: boolean; detail?: string } {
  if (effective.source === "machine" && effective.machine) {
    if (running.provider !== "cloudflare-named") {
      return {
        ok: false,
        restart: true,
        detail: "running bridge is not serving the machine named tunnel",
      };
    }
    if (effective.machine.configId && running.tunnelConfigId !== effective.machine.configId) {
      return {
        ok: false,
        restart: true,
        detail: "running bridge was started from a different machine config",
      };
    }
    if (running.url && running.url !== effective.machine.publicUrl) {
      return {
        ok: false,
        restart: true,
        detail: `running tunnel URL ${running.url} does not match the machine address ${effective.machine.publicUrl}`,
      };
    }
    return { ok: true, restart: false };
  }
  return { ok: true, restart: false };
}
