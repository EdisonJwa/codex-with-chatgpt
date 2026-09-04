import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Guards the CLI entry itself: the V2 refactor once shipped with the
 * `program.parseAsync()` call missing — every command exited 0, silently
 * doing nothing, and no module-level test could notice. These smoke tests
 * run the actual binary the user runs.
 */
describe("c2c binary smoke", () => {
  const run = (args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [path.join(projectRoot, "bin", "c2c.js"), ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, C2C_STATE_DIR: path.join(projectRoot, ".tooling", "test-tmp", "cli-smoke") },
    });

  it("prints the version", () => {
    const result = run(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints help listing the real commands", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    for (const command of ["start", "setup", "status", "doctor", "selftest", "pair", "unpair", "session", "logs", "tunnel", "sandbox-allow", "update-check"]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("rejects unknown commands with a non-zero exit", () => {
    const result = run(["definitely-not-a-command"]);
    expect(result.status).not.toBe(0);
  });
});
