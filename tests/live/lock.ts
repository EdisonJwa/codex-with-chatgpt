import fs from "node:fs";
import path from "node:path";

/**
 * Serialization for live tests (oracle liveLock-inspired): live runs hit real
 * network services and must never overlap. mkdir is atomic on all platforms,
 * so a held lock is simply an existing directory. Bounded wait, then fail —
 * live runs are manually invoked, nobody should be silently queued.
 */
const LOCK_DIR = path.join(process.cwd(), ".tooling", "live-lock");

export async function withLiveLock<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
      break;
    } catch {
      if (attempt >= 12) {
        throw new Error(`live lock held: ${LOCK_DIR} (another live run in progress?)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmdirSync(LOCK_DIR);
    } catch {
      // best effort
    }
  }
}
