import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CloudflaredNamedTunnel } from "../src/tunnel/cloudflared-named.js";
import { acquireTunnelOwnership, pidAlive } from "../src/tunnel/ownership.js";
import { nullLogger } from "../src/logger/index.js";
import { cleanup, isolateStateDir } from "./helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A real live process with a pid distinct from the test runner's. */
function spawnSleeper(): { pid: number; kill: () => void } {
  const child: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

function lockFileFor(stateDir: string, target: string): string {
  const hash = createHash("sha256").update(target).digest("hex").slice(0, 16);
  return path.join(stateDir, "runtime", "tunnels", `tunnel-${hash}.lock`);
}

/**
 * A fixed hostname must be served by exactly one connector: two bridges
 * running cloudflared for the same hostname with different local ports would
 * make Cloudflare round-robin requests onto the wrong workspace. The
 * ownership claim makes a second start fail loudly instead.
 */
describe("tunnel ownership", () => {
  afterAll(() => {
    // no global state beyond the isolated state dirs
  });

  it("a live holder blocks a second claim, naming the holder workspace", () => {
    const stateDir = isolateStateDir();
    const holderProc = spawnSleeper();
    const claimantProc = spawnSleeper();
    try {
      const first = acquireTunnelOwnership(
        "my-laptop",
        { pid: holderProc.pid, workspaceId: "ws-a" },
        "https://c2c-a.example.com"
      );
      expect(() =>
        acquireTunnelOwnership(
          "my-laptop",
          { pid: claimantProc.pid, workspaceId: "ws-b" },
          "https://c2c-b.example.com"
        )
      ).toThrow(/ws-a/);
      first.release();
    } finally {
      holderProc.kill();
      claimantProc.kill();
      cleanup(path.join(stateDir, "runtime", "tunnels"));
    }
  });

  it("a live same-PID holder counts as live, not stale", () => {
    const stateDir = isolateStateDir();
    try {
      const first = acquireTunnelOwnership("my-laptop", { pid: process.pid, workspaceId: "ws-a" }, "https://c2c-a.example.com");
      // Same process claims again (e.g. two provider instances in one bridge):
      // the recorded pid IS alive, so this is a live-holder conflict, never
      // the "no longer running" stale branch.
      expect(() =>
        acquireTunnelOwnership("my-laptop", { pid: process.pid, workspaceId: "ws-a" }, "https://c2c-a.example.com")
      ).toThrow(/currently served by/);
      first.release();
    } finally {
      cleanup(path.join(stateDir, "runtime", "tunnels"));
    }
  });

  it("release frees the claim for the next bridge", () => {
    const stateDir = isolateStateDir();
    try {
      const first = acquireTunnelOwnership("my-laptop", { pid: process.pid, workspaceId: "ws-a" }, "https://c2c-a.example.com");
      first.release();
      const second = acquireTunnelOwnership("my-laptop", { pid: process.pid, workspaceId: "ws-b" }, "https://c2c-b.example.com");
      second.release();
    } finally {
      cleanup(path.join(stateDir, "runtime", "tunnels"));
    }
  });

  it("the claim stays held while the connector child is terminating", async () => {
    const stateDir = isolateStateDir();
    try {
      const { PassThrough } = await import("node:stream");
      const { EventEmitter } = await import("node:events");
      const { CloudflaredNamedTunnel } = await import("../src/tunnel/cloudflared-named.js");
      const { nullLogger } = await import("../src/logger/index.js");

      const makeFakeChild = (exitDelayMs: number) => {
        const child: any = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
          setTimeout(() => child.emit("exit", 0, null), exitDelayMs);
          return true;
        };
        return child;
      };

      let fake = makeFakeChild(500);
      const provider = new CloudflaredNamedTunnel({
        hostname: "c2c-test.example.com",
        tunnelId: "b42367b0-4892-4dbe-a3c2-279e6de880f4",
        logger: nullLogger,
        binaryOverride: "fake-cloudflared",
        spawnOverride: () => {
          queueMicrotask(() => fake.stdout.end("Registered tunnel connection\n"));
          return fake;
        },
        // Fail-closed verification passes instantly against this stub.
        fetchImpl: (async () => ({
          ok: true,
          json: async () => ({ service: "c2c-bridge" }),
        })) as unknown as typeof fetch,
        owner: { pid: process.pid, workspaceId: "ws-holder" },
      });

      await provider.start(48765); // claims the hostname, connector "connected"

      // Initiate stop: the fake child exits 500ms after SIGTERM.
      const stopping = provider.stop();
      // While the child is still terminating, the hostname stays claimed.
      expect(() =>
        acquireTunnelOwnership(
          "c2c-test.example.com",
          { pid: process.pid, workspaceId: "ws-other" },
          "https://c2c-test.example.com"
        )
      ).toThrow(/currently served by/);
      // Only after stop() resolves (child confirmed gone) is the claim free.
      await stopping;
      const freed = acquireTunnelOwnership(
        "c2c-test.example.com",
        { pid: process.pid, workspaceId: "ws-other" },
        "https://c2c-test.example.com"
      );
      freed.release();
    } finally {
      cleanup(path.join(stateDir, "runtime", "tunnels"));
    }
  });

  it("a stale claim (dead holder) is reclaimed atomically after a crash", async () => {
    const stateDir = isolateStateDir();
    const crashed = spawnSleeper();
    try {
      const holder = acquireTunnelOwnership("my-laptop", { pid: crashed.pid, workspaceId: "ws-a" }, "https://c2c-a.example.com");
      void holder; // never released — simulates a crash while holding the claim
      crashed.kill();
      const deadline = Date.now() + 5000;
      while (pidAlive(crashed.pid) && Date.now() < deadline) await sleep(50);
      expect(pidAlive(crashed.pid)).toBe(false);

      // Crash residue must NOT block recovery: the new starter reclaims the
      // dead generation and proceeds (found blocking a real doctor gate).
      const reclaimed = acquireTunnelOwnership("my-laptop", { pid: process.pid, workspaceId: "ws-b" }, "https://c2c-b.example.com");

      // While ws-b holds it live, a third starter still fails closed.
      expect(() =>
        acquireTunnelOwnership("my-laptop", { pid: process.pid, workspaceId: "ws-c" }, "https://c2c-c.example.com")
      ).toThrow(/currently served by.*ws-b/s);

      // No reclaim temp residue is left behind.
      const dir = path.join(stateDir, "runtime", "tunnels");
      expect(fs.readdirSync(dir).filter((f) => f.includes(".reclaim"))).toEqual([]);

      reclaimed.release();
      const after = acquireTunnelOwnership("my-laptop", { pid: process.pid, workspaceId: "ws-d" }, "https://c2c-d.example.com");
      after.release();
    } finally {
      cleanup(path.join(stateDir, "runtime", "tunnels"));
    }
  });

  it("an unreadable lock file fails closed instead of overwriting", () => {
    const stateDir = isolateStateDir();
    try {
      const seed = acquireTunnelOwnership("my-laptop", { pid: process.pid, workspaceId: "ws-a" }, "https://c2c-a.example.com");
      seed.release();
      fs.writeFileSync(lockFileFor(stateDir, "my-laptop"), "{ truncated");
      expect(() =>
        acquireTunnelOwnership("my-laptop", { pid: process.pid, workspaceId: "ws-b" }, "https://c2c-b.example.com")
      ).toThrow(/cannot be read/);
    } finally {
      cleanup(path.join(stateDir, "runtime", "tunnels"));
    }
  });

  it("the named provider refuses to start while another workspace holds the claim", async () => {
    const stateDir = isolateStateDir();
    const holderProc = spawnSleeper();
    const claimantProc = spawnSleeper();
    try {
      // The claim is keyed by hostname, which is what DNS routes on.
      const blocking = acquireTunnelOwnership(
        "c2c-test.example.com",
        { pid: holderProc.pid, workspaceId: "ws-a" },
        "https://c2c-test.example.com"
      );
      const provider = new CloudflaredNamedTunnel({
        tunnelName: "test-laptop",
        hostname: "c2c-test.example.com",
        logger: nullLogger,
        // Deterministic binary check on every platform; the claim fails
        // before any process would be spawned.
        binaryOverride: process.execPath,
        owner: { pid: claimantProc.pid, workspaceId: "ws-b" },
      });
      await expect(provider.start(48765)).rejects.toThrow(/ws-a/);
      expect(provider.status().running).toBe(false);
      // The failed start must not have consumed the holder's claim.
      blocking.release();
      const again = acquireTunnelOwnership("test-laptop", { pid: process.pid, workspaceId: "ws-a" }, "https://c2c-a.example.com");
      again.release();
    } finally {
      holderProc.kill();
      claimantProc.kill();
      cleanup(path.join(stateDir, "runtime", "tunnels"));
    }
  });
});
