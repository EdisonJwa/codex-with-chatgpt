import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COMMON_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  path.join(process.env.HOME ?? "", ".local", "bin"),
  "C:\\Program Files\\cloudflared",
  "C:\\Program Files (x86)\\cloudflared",
];

/**
 * Locate a binary on PATH or in common install locations.
 * `C2C_<NAME>_PATH` (e.g. C2C_CLOUDFLARED_PATH) wins outright — an explicit
 * override must never be silently second-guessed by auto-detection.
 */
export function findBinary(name: string): string | null {
  const override = process.env[`C2C_${name.toUpperCase()}_PATH`]?.trim();
  if (override) return override;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  try {
    const probe = spawnSync(exe, ["--version"], { stdio: "ignore", timeout: 5000 });
    if (probe.status === 0 || probe.status === 1) return exe; // on PATH
  } catch {
    // not on PATH
  }
  for (const dir of COMMON_DIRS) {
    const full = path.join(dir, exe);
    try {
      if (fs.existsSync(full)) {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      }
    } catch {
      // try next
    }
  }
  return null;
}

export interface TunnelBinaries {
  cloudflared: string | null;
  wrangler: string | null;
}

export function detectTunnelBinaries(): TunnelBinaries {
  return {
    cloudflared: findBinary("cloudflared"),
    wrangler: findBinary("wrangler"),
  };
}
