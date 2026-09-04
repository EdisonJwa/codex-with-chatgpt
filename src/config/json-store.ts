import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "./paths.js";

/**
 * Atomic, strict JSON persistence for security-relevant state.
 *
 * - writeJsonAtomic: temp file + rename in the same directory, so a crash
 *   can never leave a truncated security state file behind.
 * - readJsonStrict: ONLY a missing file is "absent". Corruption,
 *   permission errors or partial writes are explicit errors — callers must
 *   never silently fall back to default state.
 */

export type StrictRead<T> =
  | { status: "absent" }
  | { status: "ok"; data: T }
  | { status: "error"; error: string };

export function readJsonStrict<T>(file: string): StrictRead<T> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return { status: "error", error: `${file} cannot be read: ${(error as Error).message}` };
  }
  try {
    return { status: "ok", data: JSON.parse(text) as T };
  } catch (error) {
    return { status: "error", error: `${file} is not valid JSON: ${(error as Error).message}` };
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  const dir = ensureDir(path.dirname(file));
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify(data, null, 2);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, body);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    // Best-effort hardening for pre-existing files created with a looser
    // mode (Windows may ignore chmod; failure is non-fatal).
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // ignore
    }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}

/** Read-or-throw helper for state that must exist. */
export function requireJson<T>(file: string, what: string): T {
  const read = readJsonStrict<T>(file);
  if (read.status === "absent") throw new Error(`${what} state file is missing: ${file}`);
  if (read.status === "error") throw new Error(read.error);
  return read.data;
}
