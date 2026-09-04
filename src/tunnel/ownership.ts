import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * A fixed hostname is the one machine-wide resource in a
 * one-bridge-per-workspace world: two bridges running cloudflared for the
 * SAME hostname with different local upstream ports would make Cloudflare
 * round-robin requests onto the wrong workspace (random 401s, endless
 * re-pairing). Before spawning cloudflared, a bridge must therefore hold the
 * ownership claim for that hostname; whoever holds it is the only connector.
 *
 * The claim lives in <stateDir>/runtime/tunnels/<hostname-hash>.lock and
 * carries the owning bridge's pid and workspace, so a conflicting start
 * fails with an actionable message.
 *
 * A claim whose holder pid is DEAD (crash residue) is reclaimed atomically:
 * the contender first RENAMES the stale lock to a private temp name — rename
 * is exclusive, so exactly one contender wins the right to replace that
 * generation — and then creates its own with openSync("wx"). A loser's
 * rename fails (ENOENT) and it re-reads, now seeing the winner's LIVE
 * generation, and fails closed. No unconditional delete of the live lock
 * file ever happens, so the two-recovering-starters race cannot produce two
 * connectors for one hostname. Unreadable lock content still fails closed:
 * state unknown means do not touch.
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
  /** The claimed DNS hostname. */
  target: string;
  identity: string;
  startedAt: string;
}

function locksDir(): string {
  return ensureDir(path.join(getStateDir(), "runtime", "tunnels"));
}

/** Filesystem-safe, collision-free name for a claimed hostname. */
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
    // ignore — a later acquirer's conflict check resolves it
  }
}

/**
 * Claim exclusive connector rights for `hostname` on this machine. A LIVE
 * holder (or unreadable lock) fails closed with an actionable error; a DEAD
 * holder is reclaimed atomically (see the module docstring). Releasing a
 * claim is always allowed for its own generation.
 */
export function acquireTunnelOwnership(
  target: string,
  owner: TunnelOwner,
  publicUrl: string
): TunnelClaim {
  const file = lockFile(target);
  // Bounded retry loop: a reclaim loser re-reads and converges on the
  // winner's LIVE generation within one or two passes; the cap turns
  // pathological contention into an explicit error instead of a spin.
  for (let attempt = 0; attempt < 5; attempt++) {
    const identity = randomBytes(12).toString("hex");
    let fd: number;
    let reclaimedTemp: string | null = null;
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
      // ANY live holder pid is a live claim — including our own pid, which
      // means this process already holds the claim and must not fall through
      // to the reclaim path below.
      if (holder && (holder.pid === owner.pid || pidAlive(holder.pid))) {
        throw new Error(
          `The fixed address ${publicUrl} is currently served by ` +
            `workspace ${holder.workspaceId} (pid ${holder.pid}). Only one bridge may ` +
            `connect a hostname at a time — stop that workspace's bridge first ` +
            `(\`c2c stop\` in that workspace), then retry.`
        );
      }
      if (!holder) {
        // File vanished between EEXIST and read (a concurrent release or
        // reclaim): retry the plain create.
        continue;
      }
      // Stale holder (crash residue): reclaim atomically. Losing the rename
      // means another contender won — re-read and converge on its decision.
      reclaimedTemp = `${file}.${identity}.reclaim`;
      try {
        fs.renameSync(file, reclaimedTemp);
      } catch {
        continue;
      }
      try {
        fd = fs.openSync(file, "wx");
      } catch (createError) {
        try {
          fs.rmSync(reclaimedTemp, { force: true });
        } catch {
          // ignore — orphan temp files are harmless
        }
        if ((createError as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw createError;
      }
    }
    const content: LockContent = {
      pid: owner.pid,
      workspaceId: owner.workspaceId,
      publicUrl,
      target,
      identity,
      startedAt: new Date().toISOString(),
    };
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
    if (reclaimedTemp) {
      // The stale generation we won the right to remove — best effort.
      try {
        fs.rmSync(reclaimedTemp, { force: true });
      } catch {
        // ignore — orphan temp files are harmless
      }
    }
    return {
      identity,
      release: (): void => removeIfGeneration(file, identity),
    };
  }
  throw new Error(
    `The tunnel ownership record for ${target} could not be settled after ` +
      `repeated attempts (${file}). If no bridge is running, remove that file and retry.`
  );
}
