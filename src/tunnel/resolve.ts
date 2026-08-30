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
  };
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
): { source: TunnelSource; provider: TunnelProvider } {
  const effective = effectiveTunnelState(workspaceId);
  if (effective.source === "machine" && effective.error) {
    throw new Error(effective.error);
  }
  if (effective.source === "machine" && effective.machine) {
    const machine = effective.machine;
    return {
      source: "machine",
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
      provider: new CloudflaredNamedTunnel({
        hostname: binding.hostname,
        tunnelName: binding.tunnelName,
        tunnelId: binding.tunnelId,
        logger,
        owner: owner ?? { pid: process.pid, workspaceId },
      }),
    };
  }
  return { source: "quick", provider: new CloudflaredQuickTunnel(logger) };
}
