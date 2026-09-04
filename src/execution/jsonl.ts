import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../config/paths.js";

/**
 * Bounded retention for append-only JSONL state (execution records, the
 * read-audit ledger): drop corrupt lines and entries older than the policy,
 * keep the newest maxRecords, rewrite atomically (temp+rename) — and only
 * touch the file when something actually changed.
 */
export interface RetentionPolicy {
  maxAgeMs: number;
  maxRecords: number;
}

export interface PruneResult {
  removed: number;
  kept: number;
}

export function pruneJsonl(file: string, policy: RetentionPolicy): PruneResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { removed: 0, kept: 0 }; // absent/unreadable: nothing to prune here
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const cutoff = Date.now() - policy.maxAgeMs;
  const fresh: string[] = [];
  for (const line of lines) {
    try {
      const ts = Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? "");
      if (Number.isFinite(ts) && ts >= cutoff) fresh.push(line);
    } catch {
      // corrupt line: dropped (self-healing rewrite)
    }
  }
  const kept = fresh.slice(-policy.maxRecords);
  const removed = lines.length - kept.length;
  if (removed <= 0) return { removed: 0, kept: lines.length };

  ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const body = kept.length === 0 ? "" : kept.join("\n") + "\n";
  fs.writeFileSync(temp, body, { mode: 0o600 });
  fs.renameSync(temp, file);
  return { removed, kept: kept.length };
}
