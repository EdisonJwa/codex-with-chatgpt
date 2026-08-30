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

  it("a claim whose process died self-heals on the next claim", async () => {
    const stateDir = isolateStateDir();
    const crashed = spawnSleeper();
    try {
      const stale = acquireTunnelOwnership("my-laptop", { pid: crashed.pid, workspaceId: "ws-a" }, "https://c2c-a.example.com");
      stale.release();
      // Leave a claim behind whose holder then dies (simulated crash — this
      // claim is never released).
      const holder = acquireTunnelOwnership("my-laptop", { pid: crashed.pid, workspaceId: "ws-a" }, "https://c2c-a.example.com");
      void holder;
      crashed.kill();
      const deadline = Date.now() + 5000;
      while (pidAlive(crashed.pid) && Date.now() < deadline) await sleep(50);
      expect(pidAlive(crashed.pid)).toBe(false);
      const reclaimed = acquireTunnelOwnership("my-laptop", { pid: process.pid, workspaceId: "ws-b" }, "https://c2c-b.example.com");
      reclaimed.release();
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
