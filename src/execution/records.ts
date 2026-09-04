import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";
import { pruneJsonl, type PruneResult, type RetentionPolicy } from "./jsonl.js";

/**
 * Lightweight execution records written by the Codex harness (via `c2c
 * record`). ChatGPT reads them through the `execution_summary` and
 * `test_status` MCP tools.
 *
 * Records double as the local continuity store for Temporary Chats: a fresh
 * chat must be able to reconstruct a non-terminal task from the goal, the
 * protocol state, a compact summary, and the next expected step — without any
 * saved ChatGPT conversation URL.
 */
export interface ExecutionRecord {
  taskId: string;
  iteration: number;
  changedFiles: string[] | number;
  tests: string | null;
  exitStatus: "ok" | "failed" | "blocked" | string;
  timestamp: string;
  notes?: string;
  /** Protocol state at recording time (INIT/PLAN/EXECUTED/DONE/BLOCKED...). */
  state?: string;
  /** The user's goal, captured at task start (INIT) for continuation briefs. */
  goal?: string;
  /** One-paragraph progress summary of what happened so far. */
  summary?: string;
  /** What the next iteration/chat is expected to do next. */
  nextExpectedStep?: string;
  /** Which agent tool produced this record (multi-tool workspaces). */
  tool?: string;
  /**
   * Optional human-readable label alongside the hex taskId — easier for
   * ChatGPT to reference in conversation and for humans to grep in `c2c logs`.
   */
  slug?: string;
}

/** Records are continuity state, not archives: 30 days / newest 500 wins. */
export const EXECUTION_RETENTION: RetentionPolicy = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxRecords: 500,
};

export function pruneExecutionRecords(workspaceId: string, policy: RetentionPolicy = EXECUTION_RETENTION): PruneResult {
  return pruneJsonl(recordsFile(workspaceId), policy);
}

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  fs.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line) as ExecutionRecord);
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}

/**
 * The most recent record that actually carries a test result. State-only
 * continuity records (INIT/HANDOFF markers with no tests) must not shadow
 * the last real test run.
 */
export function latestExecutionRecordWithTests(workspaceId: string): ExecutionRecord | null {
  // A state-only record is worth scanning past, but bound the search so a
  // long all-marker history cannot scan the whole file every call.
  const records = readExecutionRecords(workspaceId, 200);
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].tests !== null && records[i].tests !== undefined) return records[i];
  }
  return null;
}
