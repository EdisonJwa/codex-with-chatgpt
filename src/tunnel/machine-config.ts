import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureJson } from "../config/paths.js";

/**
 * Machine-level fixed-address configuration, stored once at
 * <stateDir>/tunnel.json. When present and valid it is an explicit
 * machine-wide override: every workspace bridge serves the same fixed
 * hostname (workspace quick/named preferences stay stored but inactive
 * until the override is removed). When present but malformed it fails
 * closed — bridges report the configuration error instead of silently
 * falling back to a rotating endpoint.
 */
export interface MachineTunnelConfig {
  version?: 1;
  mode: "cloudflare-named";
  publicUrl: string;
  tunnelName?: string;
  tunnelId?: string;
  credentialsFile: string;
}

export interface ResolvedMachineTunnel {
  /** DNS hostname the fixed address routes on (claim key). */
  hostname: string;
  /** What cloudflared actually runs: the tunnel UUID when available, else the name. */
  target: string;
  tunnelName?: string;
  tunnelId?: string;
  credentialsFile: string;
  publicUrl: string;
}

export function machineTunnelFile(): string {
  return path.join(getStateDir(), "tunnel.json");
}

export type MachineTunnelReadResult =
  | { status: "absent" }
  | { status: "ok"; config: MachineTunnelConfig; resolved: ResolvedMachineTunnel }
  | { status: "malformed"; error: string };

export function parseMachineTunnelConfig(value: unknown): ResolvedMachineTunnel | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.mode !== "cloudflare-named") return null;
  if (typeof v.publicUrl !== "string" || v.publicUrl.trim() === "") return null;
  if (typeof v.credentialsFile !== "string" || v.credentialsFile.trim() === "") return null;
  const hasName = typeof v.tunnelName === "string" && v.tunnelName.trim() !== "";
  const hasId = typeof v.tunnelId === "string" && v.tunnelId.trim() !== "";
  if (!hasName && !hasId) return null;

  let publicUrl: string;
  let hostname: string;
  try {
    const parsed = new URL(v.publicUrl.trim());
    if (parsed.protocol !== "https:" || (parsed.pathname && parsed.pathname !== "/") || parsed.search) {
      return null;
    }
    publicUrl = parsed.origin;
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname === "") return null;

  const tunnelName = hasName ? (v.tunnelName as string).trim() : undefined;
  const tunnelId = hasId ? (v.tunnelId as string).trim() : undefined;
  const credentialsFile = path.resolve((v.credentialsFile as string).trim());
  // Prefer the tunnel UUID as the run target; the name is display/fallback.
  const target = tunnelId ?? tunnelName!;
  return { hostname, target, tunnelName, tunnelId, credentialsFile, publicUrl };
}

export function readMachineTunnel(): MachineTunnelReadResult {
  let text: string;
  try {
    text = fs.readFileSync(machineTunnelFile(), "utf8");
  } catch {
    return { status: "absent" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      status: "malformed",
      error: `tunnel.json is not valid JSON (${(error as Error).message}); fix or remove ${machineTunnelFile()}`,
    };
  }
  const resolved = parseMachineTunnelConfig(raw);
  if (!resolved) {
    return {
      status: "malformed",
      error:
        "tunnel.json is not a valid machine named-tunnel config " +
        '(need { mode: "cloudflare-named", publicUrl: "https://...", tunnelName or tunnelId, credentialsFile }); ' +
        `fix or remove ${machineTunnelFile()}`,
    };
  }
  return {
    status: "ok",
    config: {
      version: 1,
      mode: "cloudflare-named",
      publicUrl: resolved.publicUrl,
      tunnelName: resolved.tunnelName,
      tunnelId: resolved.tunnelId,
      credentialsFile: resolved.credentialsFile,
    },
    resolved,
  };
}

export function writeMachineTunnelConfig(config: MachineTunnelConfig): void {
  writeSecureJson(machineTunnelFile(), { version: 1, ...config });
}

export function clearMachineTunnelConfig(): void {
  try {
    fs.rmSync(machineTunnelFile(), { force: true });
  } catch {
    // ignore
  }
}
