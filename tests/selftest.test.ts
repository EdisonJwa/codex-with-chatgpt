import { describe, it, expect, afterAll } from "vitest";
import { type Host } from "../src/host/server.js";
import { runSelftest } from "../src/host/selftest.js";
import { makeTmpDir, cleanup, write, isolateStateDir, startTestHost } from "./helpers.js";

/**
 * §13.5: selftest drives the REAL connector path (pairing -> DCR -> PKCE ->
 * authorized MCP reads -> revocation). Here over loopback against an
 * in-process host; the live suite (tests/live) runs the same flow through a
 * real tunnel.
 */
describe("c2c selftest (loopback path)", () => {
  let host: Host;
  let root: string;
  let stateDir: string;

  afterAll(async () => {
    await host?.close().catch(() => undefined);
    if (root) cleanup(root);
    if (stateDir) cleanup(stateDir);
  });

  it("completes every step and ends with its own credentials revoked", async () => {
    stateDir = isolateStateDir();
    root = makeTmpDir("selftest-ws");
    write(root, "probe.txt", "selftest probe\n");
    // persist: true so ensureHostForWorkspace (inside selftest) finds THIS
    // host instead of spawning a daemon.
    host = await startTestHost({ workspaceRoot: root, persist: true });

    const result = await runSelftest({ workspaceRoot: root, loopback: true });
    for (const step of result.steps) {
      if (!step.ok) console.error(`selftest failed at ${step.step}: ${step.detail}`);
    }
    expect(result.steps.map((step) => step.step)).toEqual([
      "host",
      "tunnel",
      "pairing",
      "dcr",
      "authorize",
      "token",
      "tools",
      "workspace_info",
      "read_file",
      "revocation",
    ]);
    expect(result.ok).toBe(true);

    // The throwaway client's tokens are gone; the workspace is still served.
    const context = host.registry.list()[0];
    expect(context).toBeDefined();
    expect(context!.authStore.tokenCount()).toBe(0);
  }, 30_000);
});
