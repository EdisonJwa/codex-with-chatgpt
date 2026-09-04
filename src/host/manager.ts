import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, getStateDir } from "../config/paths.js";
import { readHostState } from "./state.js";
import type { HostState } from "./state.js";
import { Workspace } from "../workspace/manager.js";
import type { Logger } from "../logger/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The one HTTP helper for host/admin traffic: timeout + bearer + JSON. */
export async function fetchJson<T>(
  port: number,
  pathname: string,
  opts: {
    method?: "GET" | "POST";
    token?: string;
    body?: unknown;
    timeoutMs?: number;
  } = {}
): Promise<{ status: number; data: T & { message?: string; error?: string } }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => ({}))) as T & { message?: string; error?: string };
    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export interface HostInfo {
  service?: string;
  version?: string;
  instanceId?: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string; detail?: string };
  tunnelSource?: "machine" | "workspace" | "quick" | "override";
  tunnelConfigId?: string;
  /** MCP surface advertisement (§13.6): lets the CLI/skill detect drift. */
  capabilities?: { schemaVersion: number; tools: string[]; resources: string[] };
  workspaces: Array<{ id: string; root: string; name: string; registeredAt: string }>;
  pid: number;
  startedAt: string;
}

/**
 * Discover a live V2 host. Strict: host.json must parse, its process must
 * be alive, /health must answer, AND the authenticated /admin/info must
 * confirm the recorded instanceId. Anything else = no host.
 */
export async function findLiveHost(): Promise<HostState | null> {
  const read = readHostState();
  if (read.status !== "ok") return null;
  const state = read.data;
  if (state.schemaVersion !== 2) return null; // V1 host record: handled by drain
  if (state.pid !== process.pid && !pidAlive(state.pid)) return null;
  try {
    const health = await fetchJson(state.port, "/health", { timeoutMs: 2_000 });
    if (health.status !== 200) return null;
    const info = await fetchJson<HostInfo>(state.port, "/admin/info", {
      token: state.adminToken,
      timeoutMs: 5_000,
    });
    if (info.status !== 200 || info.data.instanceId !== state.instanceId) return null;
    return state;
  } catch {
    return null;
  }
}

export async function registerWithHost(
  state: HostState,
  workspaceRoot: string
): Promise<{ workspaceId: string; workspaceName: string }> {
  const { status, data } = await fetchJson<{ workspaceId: string; workspaceName: string }>(
    state.port,
    "/admin/workspaces/register",
    { method: "POST", token: state.adminToken, body: { workspaceRoot }, timeoutMs: 30_000 }
  );
  if (status !== 200) {
    throw new Error(data.message ?? `Workspace registration failed (${status})`);
  }
  return { workspaceId: data.workspaceId, workspaceName: data.workspaceName };
}

/**
 * Ensure the workspace is served by the machine host.
 * - live host -> register (idempotent) and done;
 * - no host  -> drain V1 bridges (fail-closed), spawn one daemon on the
 *   fixed port, wait for it to win the election, then register. The spawned
 *   loser path (port taken by a concurrently starting host) registers with
 *   the winner from inside serve and exits.
 * - port held by a non-C2C process -> explicit failure.
 */
export async function ensureHostForWorkspace(
  workspaceRoot: string,
  opts: { logger?: Logger } = {}
): Promise<{ host: HostState; registered: boolean; spawned: boolean }> {
  const logger: Logger =
    opts.logger ??
    ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger);
  const live = await findLiveHost();
  if (live) {
    await registerWithHost(live, workspaceRoot);
    return { host: live, registered: true, spawned: false };
  }

  // V1 drain MUST complete before the V2 host spawns its connector.
  await drainLegacyBridges(logger);

  const workspace = new Workspace(workspaceRoot);
  const logDir = path.join(getStateDir(), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `host-${workspace.id}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    [...args, "serve", "--workspace", workspace.root],
    { detached: true, stdio: ["ignore", out, out], windowsHide: true, env: { ...process.env } }
  );
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 25_000;
  let serveError: Error | null = null;
  while (Date.now() < deadline) {
    await sleep(300);
    const host = await findLiveHost();
    if (host) {
      await registerWithHost(host, workspace.root);
      // If our spawned serve lost the election it registers too and exits;
      // nothing else to do here.
      return { host, registered: true, spawned: true };
    }
    if (child.exitCode !== null && child.exitCode !== 0 && !serveError) {
      serveError = new Error(`Host process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  // Distinguish "port held by a foreign program" for an actionable message.
  try {
    const probe = await fetchJson(DEFAULT_PORT, "/health", { timeoutMs: 2_000 });
    if (probe.data && (probe.data as { service?: string }).service !== "c2c-bridge") {
      throw new Error(
        `Port ${DEFAULT_PORT} is held by another program. The machine host needs that port; stop the program and retry.`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Port ")) throw error;
  }
  throw serveError ?? new Error(`Host did not become healthy within 25s. See ${logFile}`);
}

/** Unregister the workspace; the host exits on its own after the grace. */
export async function stopWorkspace(workspaceRoot: string): Promise<boolean> {
  const host = await findLiveHost();
  if (!host) return false;
  const workspace = new Workspace(workspaceRoot);
  const { status, data } = await fetchJson<{ removed?: boolean }>(host.port, "/admin/workspaces/unregister", {
    method: "POST",
    token: host.adminToken,
    body: { workspaceId: workspace.id },
    timeoutMs: 10_000,
  });
  return status === 200 && data.removed === true;
}

/**
 * V1 drain: stop every legacy (pre-V2) bridge process on this machine
 * BEFORE the V2 host starts its connector. Fail-closed — a legacy bridge
 * that refuses to stop blocks V2 startup rather than risking two named
 * connectors for one hostname.
 */
export async function drainLegacyBridges(logger: Logger): Promise<void> {
  const runtimeDir = path.join(getStateDir(), "runtime");

  // (a) A live V1 host record (has `instance`, not `instanceId`).
  const legacyHostRead = readHostState();
  if (legacyHostRead.status === "ok") {
    const legacy = legacyHostRead.data as unknown as {
      instance?: string;
      schemaVersion?: number;
      port?: number;
      adminToken?: string;
      pid?: number;
    };
    if (legacy.instance && legacy.schemaVersion === undefined) {
      await stopLegacyProcess(legacy.port, legacy.adminToken, legacy.pid, "legacy host", logger);
    }
  }

  // (b) Legacy per-workspace runtime records.
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(runtimeDir)
      .filter((name) => name.endsWith(".json") && name !== "host.json");
  } catch {
    return;
  }
  for (const name of entries) {
    const file = path.join(runtimeDir, name);
    let record: { adminToken?: string; port?: number; pid?: number; workspaceId?: string };
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // not ours / unreadable: leave it
    }
    if (!record.adminToken || !record.port || !record.workspaceId) continue;
    logger.warn(`Stopping legacy bridge for workspace ${record.workspaceId}`);
    await stopLegacyProcess(record.port, record.adminToken, record.pid, `legacy bridge ${record.workspaceId}`, logger);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }

  // (c) The old host record file (superseded by V2 host.json) — keep the
  // file absent so findLiveHost never sees a V1 record again.
  if (legacyHostRead.status === "ok") {
    const legacy = legacyHostRead.data as unknown as { instance?: string };
    if (legacy.instance) {
      try {
        fs.rmSync(path.join(runtimeDir, "host.json"), { force: true });
      } catch {
        // ignore
      }
    }
  }
}

async function stopLegacyProcess(
  port: number | undefined,
  adminToken: string | undefined,
  pid: number | undefined,
  what: string,
  logger: Logger
): Promise<void> {
  if (adminToken && port) {
    try {
      await fetchJson(port, "/admin/shutdown", { method: "POST", token: adminToken, timeoutMs: 5_000 });
    } catch {
      // fall through to signal-based stop
    }
  }
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  const deadline = Date.now() + 10_000;
  while (pid && pidAlive(pid) && Date.now() < deadline) {
    await sleep(300);
  }
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
    await sleep(1_000);
    if (pidAlive(pid)) {
      throw new Error(
        `A ${what} (pid ${pid}) refused to stop. The V2 host cannot start safely while it runs. Stop it manually, then retry.`
      );
    }
  }
  if (port) {
    // Wait for the port to actually free up.
    const deadline2 = Date.now() + 10_000;
    while (Date.now() < deadline2) {
      try {
        await fetchJson(port, "/health", { timeoutMs: 800 });
      } catch {
        return; // port free
      }
      await sleep(300);
    }
  }
}
