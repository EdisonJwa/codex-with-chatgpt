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
 * Fail-closed: an existing claim file is NEVER removed automatically — not
 * for a live holder, and not for a holder whose pid looks dead. A dead-pid
 * reclaim race between two recovering starters could let one delete the
 * other's freshly created generation, so a stale claim instead blocks
 * startup with an actionable manual remediation (one file deletion).
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
 * Claim exclusive connector rights for `hostname` on this machine. Any
 * existing claim — live holder, dead holder, or unreadable file — fails
 * closed with an actionable error; releasing a claim is always allowed for
 * its own generation.
 */
export function acquireTunnelOwnership(
  target: string,
  owner: TunnelOwner,
  publicUrl: string
): TunnelClaim {
  const file = lockFile(target);
  const identity = randomBytes(12).toString("hex");
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
    throw new Error(
      holder
        ? `The tunnel ownership record for ${target} names holder workspace ` +
          `${holder.workspaceId} (pid ${holder.pid}), which is no longer running. ` +
          `Remove the stale record ${file} and retry.`
        : `The tunnel ownership record for ${target} is unavailable (${file}). ` +
          `If no bridge is running, remove that file and retry.`
    );
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
  return {
    identity,
    release: (): void => removeIfGeneration(file, identity),
  };
}
