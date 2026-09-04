import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  appendExecutionRecord,
  latestExecutionRecord,
  latestExecutionRecordWithTests,
  readExecutionRecords,
  pruneExecutionRecords,
  EXECUTION_RETENTION,
} from "../src/execution/records.js";
import { readAuditEntries } from "../src/execution/audit.js";
import { pruneJsonl } from "../src/execution/jsonl.js";
import fs from "node:fs";
import { cleanup, isolateStateDir, write } from "./helpers.js";

/**
 * Temporary Chats have no saved conversation URL: a replacement chat must be
 * able to reconstruct a non-terminal task purely from the local execution
 * records (goal + protocol state + summary + next expected step).
 */
describe("execution record continuity", () => {
  it("stores goal/state/summary/next-step and returns them back", () => {
    const stateDir = isolateStateDir();
    try {
      appendExecutionRecord("ws-cont", {
        taskId: "c2c_9f2d",
        iteration: 0,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
        state: "INIT",
        goal: "Refactor the tunnel config and adopt temporary chats",
        summary: "Task started; plan under review.",
        nextExpectedStep: "Wait for ChatGPT's PLAN reply.",
      });
      const records = readExecutionRecords("ws-cont");
      expect(records).toHaveLength(1);
      expect(records[0].state).toBe("INIT");
      expect(records[0].goal).toContain("temporary chats");
      expect(records[0].nextExpectedStep).toContain("PLAN");

      const latest = latestExecutionRecord("ws-cont");
      expect(latest?.goal).toBeTruthy();
    } finally {
      cleanup(path.join(stateDir, "executions"));
    }
  });

  it("the original goal is still retrievable after more than 5 records", () => {
    const stateDir = isolateStateDir();
    try {
      appendExecutionRecord("ws-long", {
        taskId: "c2c_long",
        iteration: 0,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
        state: "INIT",
        goal: "the original user goal",
      });
      for (let i = 1; i <= 8; i++) {
        appendExecutionRecord("ws-long", {
          taskId: "c2c_long",
          iteration: i,
          changedFiles: i,
          tests: `${i} passed`,
          exitStatus: "ok",
          timestamp: new Date().toISOString(),
          state: "EXECUTED",
        });
      }
      const wide = readExecutionRecords("ws-long", 50);
      const init = wide.find((record) => record.state === "INIT");
      expect(init?.goal).toBe("the original user goal");
      expect(latestExecutionRecordWithTests("ws-long")?.iteration).toBe(8);
    } finally {
      cleanup(path.join(stateDir, "executions"));
    }
  });

  it("test_status source skips state-only records to find the last real test run", () => {
    const stateDir = isolateStateDir();
    try {
      appendExecutionRecord("ws-cont2", {
        taskId: "c2c_1111",
        iteration: 1,
        changedFiles: 3,
        tests: "27 passed",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      });
      // a later state-only continuity record with no tests
      appendExecutionRecord("ws-cont2", {
        taskId: "c2c_1111",
        iteration: 2,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
        state: "EXECUTED",
        summary: "Review in progress.",
      });
      const withTests = latestExecutionRecordWithTests("ws-cont2");
      expect(withTests?.tests).toBe("27 passed");
      expect(withTests?.iteration).toBe(1);
    } finally {
      cleanup(path.join(stateDir, "executions"));
    }
  });
});

/**
 * Retention (§13.1): records and the audit ledger are bounded state, not
 * archives — pruned on host start by age + count with an atomic rewrite.
 */
describe("execution record retention", () => {
  it("prunes by age and count, keeps the newest, and survives a reopen", () => {
    const stateDir = isolateStateDir();
    try {
      const old = new Date(Date.now() - EXECUTION_RETENTION.maxAgeMs - 60_000).toISOString();
      for (let i = 0; i < 12; i++) {
        appendExecutionRecord("ws-prune", {
          taskId: "c2c_prune",
          iteration: i,
          changedFiles: 0,
          tests: `${i} passed`,
          exitStatus: "ok",
          timestamp: i === 0 ? old : new Date().toISOString(),
        });
      }
      const result = pruneExecutionRecords("ws-prune", { maxAgeMs: 1000, maxRecords: 5 });
      expect(result.removed).toBe(7); // 1 too-old + 6 beyond the newest 5
      const kept = readExecutionRecords("ws-prune", 50);
      expect(kept).toHaveLength(5);
      expect(kept[0].iteration).toBe(7);
      expect(kept[4].iteration).toBe(11);
    } finally {
      cleanup(path.join(stateDir, "executions"));
    }
  });

  it("drops corrupt lines (self-healing) and is a no-op when nothing to prune", () => {
    const stateDir = isolateStateDir();
    try {
      appendExecutionRecord("ws-corrupt", {
        taskId: "c2c_c1",
        iteration: 1,
        changedFiles: 0,
        tests: "1 passed",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      });
      const file = path.join(stateDir, "executions", "ws-corrupt.jsonl");
      fs.appendFileSync(file, "{ not json\n", { mode: 0o600 });

      const result = pruneExecutionRecords("ws-corrupt", EXECUTION_RETENTION);
      expect(result.removed).toBe(1);
      expect(readExecutionRecords("ws-corrupt", 10)).toHaveLength(1);

      const again = pruneExecutionRecords("ws-corrupt", EXECUTION_RETENTION);
      expect(again.removed).toBe(0);
    } finally {
      cleanup(path.join(stateDir, "executions"));
    }
  });

  it("prunes the audit ledger with the same mechanism", () => {
    const stateDir = isolateStateDir();
    try {
      const file = path.join(stateDir, "audit", "ws-audit.jsonl");
      write(stateDir, path.join("audit", "ws-audit.jsonl"), "");
      const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(
        file,
        `${JSON.stringify({ timestamp: old, clientId: "old", tool: "read_file" })}\n` +
          `${JSON.stringify({ timestamp: new Date().toISOString(), clientId: "new", tool: "git_status" })}\n`,
        { mode: 0o600 }
      );
      pruneJsonl(file, { maxAgeMs: 14 * 24 * 60 * 60 * 1000, maxRecords: 100 });
      const entries = readAuditEntries("ws-audit", 10);
      expect(entries.map((entry) => entry.clientId)).toEqual(["new"]);
    } finally {
      cleanup(path.join(stateDir, "audit"));
    }
  });
});
