import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * A fixed-domain named tunnel is the one machine-wide resource in a
 * one-bridge-per-workspace world: two bridges running cloudflared for the
 * SAME tunnel with different local upstream ports would make Cloudflare
 * round-robin requests onto the wrong workspace (random 401s, endless
 * re-pairing). Before spawning cloudflared, a bridge must therefore hold the
 * ownership claim for that tunnel; whoever holds it is the only connector.
 *
 * The claim lives in <stateDir>/runtime/tunnels/<target-hash>.lock and carries
 * the owning bridge's pid and workspace, so a conflicting start fails with an
 * actionable message and a claim whose process died self-heals on the next
 * start (deletion is generation-checked, so only the dead generation goes).
 */
export interface TunnelOwner {
  pid: number;
  workspaceId: string;
}

export interface TunnelClaim {
  /** Random per-acquisition identity; release() only deletes its own generation. */
  identity: string;
  release(): void;
}

interface LockContent {
  pid: number;
  workspaceId: string;
  publicUrl: string;
  target: string;
  identity: string;
  startedAt: string;
}

function locksDir(): string {
  return ensureDir(path.join(getStateDir(), "runtime", "tunnels"));
}

/** Filesystem-safe, collision-free name for a tunnel id or name. */
function lockFile(target: string): string {
  const hash = createHash("sha256").update(target).digest("hex").slice(0, 16);
  return path.join(locksDir(), `tunnel-${hash}.lock`);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readHolder(file: string): LockContent | null | "unreadable" {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LockContent;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "unreadable"; // empty/partial write: state unknown
  }
}

function removeIfGeneration(file: string, identity: string): void {
  // Generation-safe delete: if another acquirer replaced the file, it is
  // theirs now and must survive.
  const holder = readHolder(file);
  if (holder === "unreadable" || holder === null) return;
  if (holder.identity !== identity) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore — a later acquirer's liveness check resolves it
  }
}

/**
 * Claim exclusive connector rights for `target` (a tunnel id or name) on this
 * machine. Fails with an actionable error while another LIVE bridge holds the
 * claim; a claim whose process is gone is removed (its generation only) and
 * the claim proceeds. Unreadable lock files fail closed, like the host state
 * never does silently.
 */
export function acquireTunnelOwnership(
  target: string,
  owner: TunnelOwner,
  publicUrl: string
): TunnelClaim {
  const file = lockFile(target);
  for (let attempt = 0; attempt < 5; attempt++) {
    const identity = randomBytes(12).toString("hex");
    const content: LockContent = {
      pid: owner.pid,
      workspaceId: owner.workspaceId,
      publicUrl,
      target,
      identity,
      startedAt: new Date().toISOString(),
    };
    let fd: number;
    try {
      fd = fs.openSync(file, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readHolder(file);
      if (holder === "unreadable") {
        throw new Error(
          `The tunnel ownership record for ${target} exists but cannot be read ` +
            `(${file}). If no bridge is running, remove that file and retry.`
        );
      }
      if (holder && holder.pid !== owner.pid && pidAlive(holder.pid)) {
        throw new Error(
          `The fixed address ${publicUrl} is currently served by ` +
            `workspace ${holder.workspaceId} (pid ${holder.pid}). Only one bridge may ` +
            `connect a hostname at a time — stop that workspace's bridge first ` +
            `(\`c2c stop\` in that workspace), then retry.`
        );
      }
      // Holder process is gone (or it is us): reclaim the dead generation.
      if (holder) removeIfGeneration(file, holder.identity);
      continue;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(content));
    } catch (writeError) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      throw writeError;
    }
    return {
      identity,
      release: (): void => removeIfGeneration(file, identity),
    };
  }
  throw new Error(
    `Could not claim the tunnel ${target} after several attempts ` +
      `(concurrent starters kept recreating ${file}). Retry.`
  );
}
