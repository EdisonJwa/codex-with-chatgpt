import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { readJsonStrict, requireJson, writeJsonAtomic, type StrictRead } from "../config/json-store.js";

/**
 * host.json — the single persistent record of the machine-wide bridge host.
 *
 * Election model: the fixed loopback port is the lock. Whoever binds it is
 * the host; losers authenticate against the winner and register their
 * workspace. host.json is written by the winner only, atomically.
 */
export const HOST_SCHEMA_VERSION = 2;

export interface HostWorkspaceRecord {
  id: string;
  root: string;
  name: string;
  registeredAt: string;
}

export interface HostState {
  schemaVersion: 2;
  /** Random per-process identity; adopters verify it against /admin/info. */
  instanceId: string;
  pid: number;
  port: number;
  adminToken: string;
  startedAt: string;
  publicUrl: string | null;
  tunnelMode: "named" | "quick" | "none";
  tunnelConfigId?: string;
  workspaces: HostWorkspaceRecord[];
}

export function hostFile(): string {
  return path.join(getStateDir(), "runtime", "host.json");
}

export function readHostState(): StrictRead<HostState> {
  return readJsonStrict<HostState>(hostFile());
}

/**
 * Host state is security-relevant (contains the admin token): a corrupt or
 * unreadable file must be surfaced, never treated as "no host".
 */
export function requireLiveCandidate(): HostState {
  return requireJson<HostState>(hostFile(), "host");
}

export function writeHostState(state: HostState): void {
  writeJsonAtomic(hostFile(), state);
}

export function clearHostState(): void {
  const read = readJsonStrict<HostState>(hostFile());
  if (read.status === "absent") return;
  try {
    writeJsonAtomic(hostFile(), { clearedAt: new Date().toISOString() });
    // cleared marker: file exists but parses as no host
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
    unlinkSync(hostFile());
  } catch {
    // ignore — absence is what matters
  }
}
