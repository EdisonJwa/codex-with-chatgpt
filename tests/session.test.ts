import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readSession, saveSession, normalizeChatUrl, sessionFile } from "../src/session/state.js";
import { cleanup, isolateStateDir, write } from "./helpers.js";

/**
 * Session URL persistence (user decision 2026-09-04): one persistent ChatGPT
 * conversation per workspace; the URL is saved locally and reopened by later
 * Codex sessions. Convenience state — corrupt file reads as "no session".
 */
describe("session url persistence", () => {
  it("saves, merges and reads a session back", () => {
    const stateDir = isolateStateDir();
    try {
      expect(readSession("ws-s1")).toBeNull();

      saveSession("ws-s1", { url: "https://chatgpt.com/c/abc-123" });
      let saved = readSession("ws-s1");
      expect(saved?.url).toBe("https://chatgpt.com/c/abc-123");

      // merge: task state added later keeps the URL
      saveSession("ws-s1", { taskId: "c2c_ab12cd34", iteration: 3, lastState: "EXECUTED" });
      saved = readSession("ws-s1");
      expect(saved?.url).toBe("https://chatgpt.com/c/abc-123");
      expect(saved?.taskId).toBe("c2c_ab12cd34");
      expect(saved?.iteration).toBe(3);
      expect(saved?.lastState).toBe("EXECUTED");

      // connector name is diagnostic metadata
      saveSession("ws-s1", { connectorName: "Codex with ChatGPT · demo" });
      expect(readSession("ws-s1")?.connectorName).toBe("Codex with ChatGPT · demo");
    } finally {
      cleanup(path.join(stateDir, "sessions"));
    }
  });

  it("normalizes conversation URLs and rejects everything else", () => {
    expect(normalizeChatUrl("https://chatgpt.com/c/ABCdef123")).toBe("https://chatgpt.com/c/ABCdef123");
    expect(normalizeChatUrl("https://chatgpt.com/c/abc123/")).toBe("https://chatgpt.com/c/abc123");
    expect(normalizeChatUrl("https://chat.openai.com/c/legacy-1")).toBe("https://chatgpt.com/c/legacy-1");
    // start page, settings, plugins, temporary-chat bootstrap: never a session
    expect(normalizeChatUrl("https://chatgpt.com/")).toBeNull();
    expect(normalizeChatUrl("https://chatgpt.com/?temporary-chat=true")).toBeNull();
    expect(normalizeChatUrl("https://chatgpt.com/plugins")).toBeNull();
    expect(normalizeChatUrl("https://chatgpt.com/#settings/Security")).toBeNull();
    expect(normalizeChatUrl("https://evil.example.com/c/abc123")).toBeNull();
    expect(normalizeChatUrl("http://chatgpt.com/c/abc123")).toBeNull();
    expect(normalizeChatUrl("not a url")).toBeNull();
  });

  it("rejects a bad URL without destroying the previously saved one", () => {
    const stateDir = isolateStateDir();
    try {
      saveSession("ws-s2", { url: "https://chatgpt.com/c/good-1" });
      expect(() => saveSession("ws-s2", { url: "https://chatgpt.com/plugins" })).toThrow(/chatgpt\.com\/c/);
      expect(readSession("ws-s2")?.url).toBe("https://chatgpt.com/c/good-1");
    } finally {
      cleanup(path.join(stateDir, "sessions"));
    }
  });

  it("clear drops everything but keeps the file as an empty shell", () => {
    const stateDir = isolateStateDir();
    try {
      saveSession("ws-s3", { url: "https://chatgpt.com/c/gone-1", taskId: "c2c_11112222" });
      saveSession("ws-s3", { clear: true });
      const saved = readSession("ws-s3");
      expect(saved?.url).toBeUndefined();
      expect(saved?.taskId).toBeUndefined();
      expect(saved?.savedAt).toBeTruthy();
    } finally {
      cleanup(path.join(stateDir, "sessions"));
    }
  });

  it("a corrupt session file reads as no session (lenient convenience state)", () => {
    const stateDir = isolateStateDir();
    try {
      write(stateDir, path.join("sessions", "ws-s4.json"), "{ truncated");
      expect(readSession("ws-s4")).toBeNull();
      // and saving again heals the file
      saveSession("ws-s4", { url: "https://chatgpt.com/c/heal-1" });
      expect(readSession("ws-s4")?.url).toBe("https://chatgpt.com/c/heal-1");
    } finally {
      cleanup(path.join(stateDir, "sessions"));
    }
  });

  it("stores the file outside the project with owner-only permissions", () => {
    const stateDir = isolateStateDir();
    try {
      saveSession("ws-s5", { url: "https://chatgpt.com/c/perm-1" });
      const file = sessionFile("ws-s5");
      expect(file).toContain(path.join("sessions", "ws-s5.json"));
      expect(fs.existsSync(file)).toBe(true);
      // atomic write leaves no temp files behind
      expect(fs.readdirSync(path.join(stateDir, "sessions"))).toEqual(["ws-s5.json"]);
    } finally {
      cleanup(path.join(stateDir, "sessions"));
    }
  });
});
