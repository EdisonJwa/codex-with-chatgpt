import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { startHost, type Host } from "../../src/host/server.js";
import { runSelftest } from "../../src/host/selftest.js";
import { makeTmpDir, cleanup, write, isolateStateDir, testPort } from "../helpers.js";
import { withLiveLock } from "./lock.js";

/**
 * §11 "real ChatGPT acceptance" + §13.4: env-gated live test driving a REAL
 * Cloudflare Quick Tunnel and the full connector path (tunnel → OAuth pairing
 * → authorized MCP reads → revocation) through the public URL.
 *
 *   C2C_LIVE=1 pnpm vitest run tests/live
 *
 * Requires `cloudflared` on PATH and network access. Serialized via the live
 * lock; skipped (cheaply) in every ordinary `pnpm test` run.
 */
const LIVE = process.env.C2C_LIVE === "1";
const hasCloudflared =
  spawnSync("cloudflared", ["--version"], { encoding: "utf8", timeout: 10_000 }).status === 0;

describe.skipIf(!LIVE)("live: real Quick Tunnel + connector path over the public URL", () => {
  let host: Host | null = null;
  let root = "";
  let stateDir = "";

  afterAll(async () => {
    await host?.close().catch(() => undefined);
    if (root) cleanup(root);
    if (stateDir) cleanup(stateDir);
  });

  it("passes selftest through a real Cloudflare Quick Tunnel", async (ctx) => {
    if (!hasCloudflared) {
      ctx.skip();
      return;
    }
    await withLiveLock(async () => {
      stateDir = isolateStateDir();
      root = makeTmpDir("live-ws");
      write(root, "live.txt", "live probe\n");

      host = await startHost({ workspaceRoot: root, port: testPort(), persist: false });

      // The Quick Tunnel starts asynchronously at host boot.
      const deadline = Date.now() + 60_000;
      while (!host.getPublicBaseUrl() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      expect(host.getPublicBaseUrl()).toBeTruthy();

      const result = await runSelftest({ workspaceRoot: root });
      for (const step of result.steps) {
        if (!step.ok) console.error(`live selftest failed at ${step.step}: ${step.detail}`);
      }
      expect(result.ok).toBe(true);
    });
  }, 180_000);
});
