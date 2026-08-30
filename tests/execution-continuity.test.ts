import { describe, it, expect } from "vitest";
import path from "node:path";
import { appendExecutionRecord, latestExecutionRecord, latestExecutionRecordWithTests, readExecutionRecords } from "../src/execution/records.js";
import { cleanup, isolateStateDir } from "./helpers.js";

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
