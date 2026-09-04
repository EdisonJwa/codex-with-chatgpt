import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";
import { pruneJsonl, type PruneResult, type RetentionPolicy } from "./jsonl.js";

/**
 * Per-identity read audit (oracle-inspired, mapped to the PULL side): every
 * MCP tool call is appended to a workspace-local ledger so the user can see
 * WHICH agent identity (OAuth client) read WHAT, WHEN. High-volume reads get
 * their own caps; the ledger must never break the read it records.
 */
export interface AuditEntry {
  /** ISO timestamp — same key as execution records (retention parses it). */
  timestamp: string;
  /** OAuth clientId of the connector that made the call ("local" in-process). */
  clientId: string;
  tool: string;
  /** Small argument subset: paths, queries, modes. Stays on this machine. */
  detail?: Record<string, unknown>;
}

const AUDIT_RETENTION: RetentionPolicy = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxRecords: 2000,
};

function auditFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "audit"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendAuditEntry(
  workspaceId: string,
  clientId: string | undefined,
  tool: string,
  detail?: Record<string, unknown>
): void {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    clientId: clientId ?? "local",
    tool,
    ...(detail && Object.keys(detail).length > 0 ? { detail } : {}),
  };
  try {
    fs.appendFileSync(auditFile(workspaceId), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // observability only — a full disk must not fail the read it records
  }
}

export function readAuditEntries(workspaceId: string, limit = 50): AuditEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(auditFile(workspaceId), "utf8");
  } catch {
    return [];
  }
  const lines = text.trim().split("\n").filter(Boolean);
  const entries: AuditEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip corrupt lines
    }
  }
  return entries;
}

export function pruneAuditEntries(workspaceId: string, policy: RetentionPolicy = AUDIT_RETENTION): PruneResult {
  return pruneJsonl(auditFile(workspaceId), policy);
}
