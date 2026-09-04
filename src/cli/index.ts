import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startHost } from "../host/server.js";
import { PortInUseError } from "../host/server.js";
import {
  drainLegacyBridges,
  ensureHostForWorkspace,
  findLiveHost,
  fetchJson,
  registerWithHost,
  stopWorkspace,
} from "../host/manager.js";
import type { HostInfo } from "../host/manager.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { appendExecutionRecord } from "../execution/records.js";
import { readAuditEntries } from "../execution/audit.js";
import { runSelftest } from "../host/selftest.js";
import { MCP_CAPABILITIES } from "../mcp/server.js";
import { readSession, saveSession, type SessionPatch } from "../session/state.js";
import {
  clearMachineTunnelConfig,
  machineTunnelFile,
  parseMachineTunnelConfig,
  readMachineTunnel,
  writeMachineTunnelConfig,
} from "../tunnel/machine-config.js";
import { effectiveTunnelState, evaluateRunningTunnel } from "../tunnel/resolve.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { ensureSandboxAllowlist } from "../config/sandbox-allow.js";
import { PRODUCT_NAME, VERSION } from "../version.js";

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("One step needed from you:");
    say("");
    say("cloudflared is not installed. Install it first (macOS: brew install cloudflared, Windows: winget install Cloudflare.cloudflared), then retry.");
  } else {
    cross(message);
  }
}

function connectorNameFor(workspaceName: string): string {
  return `C2C · ${workspaceName}`;
}

/** The connector-facing URL for the current host deployment. */
function mcpUrlFor(publicUrl: string | null, port: number): string {
  return publicUrl ? `${publicUrl}/mcp` : `http://127.0.0.1:${port}/mcp`;
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean }
  | { ok: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, added: result.added, alreadyAllowed: result.alreadyAllowed };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function getHostInfo(host: { port: number; adminToken: string }): Promise<HostInfo> {
  const { status, data } = await fetchJson<HostInfo>(host.port, "/admin/info", {
    token: host.adminToken,
    timeoutMs: 10_000,
  });
  if (status !== 200) throw new Error(data.message ?? `Host info failed (${status})`);
  return data;
}

const program = new Command();

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — one machine host, many workspaces, any coding agent.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the machine host in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .action(async (opts: { workspace: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const root = resolveWorkspace(opts.workspace);
    try {
      const host = await startHost({ workspaceRoot: root, logger });
      const shutdown = (): void => {
        void host.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      say(`host ready on http://127.0.0.1:${host.port} (${host.registry.size} workspace(s))`);
    } catch (error) {
      if (error instanceof PortInUseError) {
        // Election loser: register this workspace with the winning host.
        const live = await findLiveHost();
        if (live) {
          await registerWithHost(live, root);
          say(`registered with the running host (port ${live.port})`);
          return;
        }
        cross(
          `Port ${error.port} is held by a process that is not a C2C host. ` +
            "Stop that program and retry."
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

// ---------------------------------------------------------------- start / setup

program
  .command("start")
  .description("Start (or reuse) the machine host and register this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { host } = await ensureHostForWorkspace(root);
      const info = await getHostInfo(host);
      const workspace = new Workspace(root);
      const mcpUrl = mcpUrlFor(info.publicUrl, info.port);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            port: info.port,
            workspaceId: workspace.id,
            mcpUrl,
            connectorName: connectorNameFor(workspace.name),
          })
        );
        return;
      }
      check(`Workspace registered (${workspace.name})`);
      say(`Connector URL: ${mcpUrl}`);
    } catch (error) {
      handleCliError(error, opts.json);
      if (opts.json) process.exitCode = 1;
    }
  });

program
  .command("setup")
  .description("First-time setup: host + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
      }
      const sandbox = trySandboxAllow();
      const { host } = await ensureHostForWorkspace(root);
      let info = await getHostInfo(host);
      const workspace = new Workspace(root);
      let mcpUrl = mcpUrlFor(info.publicUrl, info.port);

      if (opts.tunnel && !info.publicUrl) {
        const reload = await fetchJson<{ url?: string; message?: string }>(info.port, "/admin/tunnel/reload", {
          method: "POST",
          token: host.adminToken,
          timeoutMs: 90_000,
        });
        if (reload.status !== 200 || !reload.data.url) {
          throw new Error(reload.data.message ?? "Tunnel start failed");
        }
        mcpUrl = `${reload.data.url}/mcp`;
        info = await getHostInfo(host);
      }

      const pairing = await fetchJson<{ code: string; expiresAt: number }>(info.port, "/admin/pairing", {
        method: "POST",
        token: host.adminToken,
        body: { workspaceId: workspace.id },
        timeoutMs: 30_000,
      });
      if (pairing.status !== 200) throw new Error(pairing.data.message ?? "Pairing failed");

      const connectorName = connectorNameFor(workspace.name);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            mcpUrl,
            pairingCode: pairing.data.code,
            pairingExpiresAt: pairing.data.expiresAt,
            workspaceName: workspace.name,
            connectorName,
            sandbox,
          })
        );
        return;
      }
      check(`Workspace recognized (${workspace.name})`);
      check("Machine host is running");
      check(mcpUrl.startsWith("https://") ? "Secure connection established" : "Local connection ready (no tunnel)");
      say("");
      say(`Connector URL: ${mcpUrl}`);
      say(`Pairing code: ${pairing.data.code} (valid ~${Math.round((pairing.data.expiresAt - Date.now()) / 60000)} min)`);
      say(`Connector name: ${connectorName}`);
      say("");
      say("Next: add the connector in ChatGPT (developer mode), then authorize with the pairing code.");
    } catch (error) {
      handleCliError(error, opts.json);
      if (opts.json) process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Unregister this workspace from the machine host")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopWorkspace(resolveWorkspace(opts.workspace));
    if (stopped) check("Workspace unregistered (the host exits on its own when the last workspace leaves)");
    else say("No running host for this workspace.");
  });

program
  .command("restart")
  .description("Re-register this workspace on the machine host")
  .option("-w, --workspace <path>")
  .option("--tunnel", "also (re)establish the secure connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopWorkspace(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { host } = await ensureHostForWorkspace(root);
      let info = await getHostInfo(host);
      if (opts.tunnel) {
        await fetchJson(info.port, "/admin/tunnel/reload", {
          method: "POST",
          token: host.adminToken,
          timeoutMs: 90_000,
        });
        info = await getHostInfo(host);
      }
      const workspace = new Workspace(root);
      check(`Workspace re-registered (${workspace.name})`);
      if (info.publicUrl) check(`Secure connection: ${info.publicUrl}`);
    } catch (error) {
      handleCliError(error, false);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show host and workspace status")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const host = await findLiveHost();
    if (!host) {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Host is not running. Use `c2c start`.");
      return;
    }
    try {
      const info = await getHostInfo(host);
      const member = info.workspaces.some((w) => w.id === workspace.id);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            running: true,
            host: {
              pid: info.pid,
              port: info.port,
              publicUrl: info.publicUrl,
              tunnel: info.tunnel,
              tunnelSource: info.tunnelSource,
            },
            workspace: { id: workspace.id, name: workspace.name, registered: member },
            mcpUrl: mcpUrlFor(info.publicUrl, info.port),
          })
        );
        return;
      }
      check(`Host: running (pid ${info.pid}, port ${info.port})`);
      check(`Tunnel: ${info.tunnel.running ? info.tunnel.url ?? "running" : "not running"}`);
      check(`Workspace: ${workspace.name} — ${member ? "registered" : "NOT registered"}`);
      say(`Connector URL: ${mcpUrlFor(info.publicUrl, info.port)}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };
    report.sandbox = { ok: true, detail: "skipped" };
    try {
      const sandbox = trySandboxAllow();
      report.sandbox = { ok: sandbox.ok, detail: sandbox.ok ? "allowed" : sandbox.error };
    } catch (error) {
      report.sandbox = { ok: false, detail: (error as Error).message };
    }

    let host = await findLiveHost();
    if (!host && opts.fix) {
      try {
        await drainLegacyBridges(new Logger({ name: "bridge" }));
        host = await findLiveHost();
        if (!host) {
          await ensureHostForWorkspace(root, { logger: new Logger({ name: "bridge" }) });
          host = await findLiveHost();
          results.push("Host started automatically");
        }
      } catch (error) {
        report.bridge = { ok: false, detail: (error as Error).message };
      }
    }
    if (host) {
      report.bridge = { ok: true, detail: `port ${host.port}` };
    } else {
      report.bridge = report.bridge ?? { ok: false, detail: "not running" };
    }

    let mcpOk = false;
    if (host) {
      try {
        const response = await fetch(`http://127.0.0.1:${host.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        mcpOk = response.status === 401;
        report.mcp = { ok: mcpOk, detail: `unauthenticated request returned ${response.status}` };
        report.oauth = { ok: mcpOk };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
      // Capability/drift check: a host older than this CLI can silently
      // serve a stale tool surface to the skill (§13.6).
      try {
        const info = await getHostInfo(host);
        const caps = info.capabilities;
        if (!caps) {
          report.capabilities = { ok: false, detail: "host does not advertise capabilities — restart the host (c2c stop on each workspace, then c2c start)" };
        } else if (caps.tools.join(",") !== MCP_CAPABILITIES.tools.join(",")) {
          report.capabilities = { ok: false, detail: `host serves [${caps.tools.join(", ")}] but this CLI expects [${MCP_CAPABILITIES.tools.join(", ")}] — restart the host` };
        } else {
          report.capabilities = { ok: true, detail: `${caps.tools.length} tools, schema v${caps.schemaVersion}` };
        }
      } catch (error) {
        report.capabilities = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel: effective machine config vs the running host.
    const effective = effectiveTunnelState(workspace.id);
    const machineMalformed = effective.source === "machine" && Boolean(effective.error);
    if (machineMalformed) {
      report.tunnel = { ok: false, detail: effective.error! };
    }
    if (host) {
      try {
        let info = await getHostInfo(host);
        const runningEval =
          effective.source === "machine" && !machineMalformed
            ? evaluateRunningTunnel(effective, {
                provider: info.tunnel.provider,
                tunnelSource: info.tunnelSource,
                tunnelConfigId: info.tunnelConfigId,
                url: info.publicUrl ?? info.tunnel.url,
              })
            : null;
        if (runningEval && !runningEval.ok) {
          if (opts.fix) {
            await stopWorkspace(root);
            await ensureHostForWorkspace(root);
            info = await getHostInfo(host);
            results.push("Host restarted to apply the machine tunnel config");
          } else {
            report.tunnel = { ok: false, detail: runningEval.detail! };
          }
        }
        if (!report.tunnel) {
          let currentUrl = info.publicUrl ?? info.tunnel.url;
          if ((!currentUrl || !(await urlHealthy(currentUrl))) && opts.fix) {
            const reload = await fetchJson<{ url?: string; message?: string }>(info.port, "/admin/tunnel/reload", {
              method: "POST",
              token: host.adminToken,
              timeoutMs: 90_000,
            });
            if (reload.status === 200 && reload.data.url) {
              currentUrl = reload.data.url;
              results.push("Secure connection re-established");
            } else if (reload.data.message) {
              report.tunnel = { ok: false, detail: reload.data.message };
            }
          }
          if (currentUrl && (await urlHealthy(currentUrl))) {
            report.tunnel = { ok: true, detail: currentUrl };
          } else {
            report.tunnel = report.tunnel ?? { ok: false, detail: "secure connection is down" };
          }
        }
      } catch (error) {
        report.tunnel = report.tunnel ?? { ok: false, detail: (error as Error).message };
      }
    } else if (!machineMalformed) {
      report.tunnel = { ok: false, detail: "host not running" };
    }

    const allOk = Object.values(report).every((entry) => entry.ok);
    if (opts.json) {
      say(JSON.stringify({ report, repairs: results, ok: allOk }));
    } else {
      say(`${PRODUCT_NAME} doctor`);
      for (const [name, entry] of Object.entries(report)) {
        say(`${entry.ok ? "✓" : "✗"} ${name}${entry.detail ? ` — ${entry.detail}` : ""}`);
      }
      for (const repair of results) say(`· ${repair}`);
      if (!allOk) process.exitCode = 1;
    }

    async function urlHealthy(url: string): Promise<boolean> {
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
        return response.ok;
      } catch {
        return false;
      }
    }
  });

// ---------------------------------------------------------------- selftest

program
  .command("selftest")
  .description("End-to-end test of the connector path: host -> tunnel -> OAuth pairing -> MCP reads")
  .option("-w, --workspace <path>")
  .option("--loopback", "test the local host directly, skipping the tunnel", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; loopback: boolean; json: boolean }) => {
    try {
      const result = await runSelftest({
        workspaceRoot: resolveWorkspace(opts.workspace),
        loopback: opts.loopback,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: result.ok, mcpUrl: result.mcpUrl, steps: result.steps }));
      } else {
        say(`${PRODUCT_NAME} selftest`);
        for (const step of result.steps) say(`${step.ok ? "✓" : "✗"} ${step.step} — ${step.detail}`);
      }
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      handleCliError(error, opts.json);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const root = resolveWorkspace(opts.workspace);
      const { host } = await ensureHostForWorkspace(root);
      const workspace = new Workspace(root);
      const pairing = await fetchJson<{ code: string; expiresAt: number }>(host.port, "/admin/pairing", {
        method: "POST",
        token: host.adminToken,
        body: { workspaceId: workspace.id },
        timeoutMs: 30_000,
      });
      if (pairing.status !== 200) throw new Error(pairing.data.message ?? "Pairing failed");
      if (opts.json) {
        say(JSON.stringify({ ok: true, pairingCode: pairing.data.code, expiresAt: pairing.data.expiresAt }));
      } else {
        say(`Pairing code: ${pairing.data.code}`);
        say(`(valid ~${Math.round((pairing.data.expiresAt - Date.now()) / 60000)} minutes, single use)`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke the agent's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const host = await findLiveHost();
    if (host) {
      await fetchJson(host.port, "/admin/revoke-all", {
        method: "POST",
        token: host.adminToken,
        body: { workspaceId: workspace.id },
        timeoutMs: 30_000,
      });
    } else {
      // Host not running: revoke directly in the persisted store.
      new AuthStore(workspace.id).revokeAll();
    }
    check("Access revoked (all tokens invalidated)");
  });

// ---------------------------------------------------------------- logs / record

program
  .command("logs")
  .description("Show recent host logs, or the MCP read audit with --audit")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--audit", "show which connector read what, instead of host logs", false)
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; audit: boolean; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    if (opts.audit) {
      const entries = readAuditEntries(workspace.id, parseInt(opts.lines, 10));
      if (entries.length === 0) {
        say("No MCP reads recorded yet for this workspace.");
        return;
      }
      for (const entry of entries) {
        const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : "";
        say(`${entry.timestamp} ${entry.clientId} ${entry.tool}${detail}`);
      }
      return;
    }
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `host-${workspace.id}.out.log`),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("No logs yet.");
  });

program
  .command("record", { hidden: true })
  .description("Record an execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--state <state>", "protocol state, e.g. INIT / EXECUTED / DONE")
  .option("--goal <text>", "the user's goal (record at task start for chat continuity)")
  .option("--summary <text>", "one-paragraph progress summary")
  .option("--next-step <text>", "what the next iteration/chat is expected to do")
  .option("--tool <name>", "which agent tool produced this record (e.g. codex, claude-code)")
  .option("--slug <text>", "short human-readable label for the task (easier to reference than the hex id)")
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: string;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      state?: string;
      goal?: string;
      summary?: string;
      nextStep?: string;
      tool?: string;
      slug?: string;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = /^\d+$/.test(opts.changedFiles)
        ? parseInt(opts.changedFiles, 10)
        : opts.changedFiles.split(",").map((file) => file.trim()).filter(Boolean);
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: parseInt(opts.iteration, 10),
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes,
        state: opts.state,
        goal: opts.goal,
        summary: opts.summary,
        nextExpectedStep: opts.nextStep,
        tool: opts.tool,
        slug: opts.slug,
      });
      check("Execution summary recorded");
    }
  );

// ---------------------------------------------------------------- session

const sessionCmd = program
  .command("session")
  .description("Show or set this workspace's saved ChatGPT conversation URL");

sessionCmd
  .command("show", { isDefault: true })
  .description("Show the saved session (chat URL + last task state)")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const saved = readSession(workspace.id);
    if (opts.json) {
      say(JSON.stringify({ ok: true, session: saved }));
      return;
    }
    if (!saved || !saved.url) {
      say("No saved session. After the first chat is verified, run `c2c session set --url <chat-url>`.");
      return;
    }
    say(`Chat URL: ${saved.url}`);
    if (saved.title) say(`Title: ${saved.title}`);
    if (saved.taskId) say(`Last task: ${saved.taskId} (iteration ${saved.iteration ?? 0}, ${saved.lastState ?? "?"})`);
    say(`Saved: ${saved.savedAt}`);
  });

sessionCmd
  .command("set")
  .description("Save or update the session (merges into what is already saved)")
  .option("-w, --workspace <path>")
  .option("--url <url>", "ChatGPT conversation URL (https://chatgpt.com/c/...)")
  .option("--title <text>")
  .option("--task <id>", "last task id worked on in this chat")
  .option("--iteration <n>", "last iteration of that task")
  .option("--state <state>", "last protocol state (INIT/PLAN/EXECUTED/DONE/BLOCKED)")
  .option("--connector-name <name>", "connector title bound to this workspace")
  .option("--clear", "forget the saved session", false)
  .option("--json", "machine-readable output", false)
  .action(
    (opts: {
      workspace?: string;
      url?: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      connectorName?: string;
      clear: boolean;
      json: boolean;
    }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const iteration =
        opts.iteration !== undefined ? parseInt(opts.iteration, 10) : undefined;
      if (iteration !== undefined && Number.isNaN(iteration)) {
        throw new Error("--iteration must be a number");
      }
      const saved = saveSession(workspace.id, {
        url: opts.url,
        title: opts.title,
        taskId: opts.task,
        iteration,
        lastState: opts.state,
        connectorName: opts.connectorName,
        clear: opts.clear || undefined,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, session: saved }));
      } else {
        check(opts.clear ? "Session cleared" : "Session saved");
        if (saved.url) say(`Chat URL: ${saved.url}`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------- sandbox-allow

program
  .command("sandbox-allow")
  .description("Allowlist the C2C state directory in the agent tool's sandbox config")
  .option("--tool <name>", "agent tool adapter", "codex")
  .option("--json", "machine-readable output", false)
  .action((opts: { tool: string; json: boolean }) => {
    if (opts.tool !== "codex") {
      handleCliError(new Error(`Unknown tool adapter: ${opts.tool}`), opts.json);
      process.exitCode = 1;
      return;
    }
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify({ ok: result.ok, added: result.ok ? result.added : false, alreadyAllowed: result.ok ? result.alreadyAllowed : false, ...(result.ok ? {} : { error: result.error }) }));
      return;
    }
    if (result.ok) {
      check(result.added ? "State directory added to the sandbox allowlist" : "State directory is already allowlisted");
    } else {
      cross(result.error);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------- update-check

program
  .command("update-check")
  .description("Check whether the local checkout is behind origin")
  .option("--force", "bypass the daily cache", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { force: boolean; json: boolean }) => {
    try {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
      const cacheFile = path.join(getStateDir(), "update-check.json");
      let cache: { checkedAt?: string } = {};
      try {
        cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      } catch {
        // no cache yet
      }
      const today = new Date().toISOString().slice(0, 10);
      if (!opts.force && cache.checkedAt === today) {
        say(JSON.stringify({ ok: true, checked: false, updateAvailable: false, note: "already checked today" }));
        return;
      }
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: today }), { mode: 0o600 });
      const result = spawnSync("git", ["fetch", "--quiet", "origin"], { cwd: repoRoot, timeout: 30_000 });
      if (result.status !== 0) {
        say(JSON.stringify({ ok: true, checked: true, updateAvailable: false, note: "offline" }));
        return;
      }
      const behind = spawnSync("git", ["rev-list", "--count", `HEAD..origin/${process.env.C2C_BRANCH || "refactor/v2"}`], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30_000,
      });
      const count = parseInt((behind.stdout ?? "0").trim(), 10) || 0;
      say(JSON.stringify({ ok: true, checked: true, updateAvailable: count > 0, behind: count }));
    } catch (error) {
      say(JSON.stringify({ ok: false, error: (error as Error).message }));
    }
  });

// ---------------------------------------------------------------- tunnel

const tunnelCmd = program.command("tunnel").description("Show or set the machine-wide secure connection");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show the effective tunnel mode and state")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const effective = effectiveTunnelState(workspace.id);
    const read = readMachineTunnel();
    let running: { url: string | null; provider: string | null; detail?: string } = { url: null, provider: null };
    const host = await findLiveHost();
    if (host) {
      try {
        const info = await getHostInfo(host);
        running = { url: info.publicUrl ?? info.tunnel.url, provider: info.tunnel.provider, detail: info.tunnel.detail };
      } catch {
        // config-only view
      }
    }
    const payload = {
      ok: true,
      effectiveSource: effective.source,
      mode: effective.source === "machine" ? "named" : effective.source === "workspace" ? "legacy-workspace" : effective.source,
      machine: read.status === "ok" ? read.resolved.publicUrl : read.status === "malformed" ? null : undefined,
      machineError: read.status === "malformed" ? read.error : undefined,
      running: running.url !== null,
      runningUrl: running.url,
      provider: running.provider,
      detail: running.detail,
    };
    if (opts.json) {
      say(JSON.stringify(payload));
      return;
    }
    if (read.status === "malformed") {
      cross(read.error);
      process.exitCode = 1;
      return;
    }
    say(`Mode: ${payload.mode === "named" ? "fixed address (machine tunnel.json)" : payload.mode === "quick" ? "rotating (Quick Tunnel)" : payload.mode}`);
    if (running.url) say(`Running: ${running.url}`);
    else say("Not running.");
  });

tunnelCmd
  .command("machine")
  .description("Show the machine-wide fixed address configuration (tunnel.json)")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const read = readMachineTunnel();
    if (opts.json) {
      say(
        JSON.stringify(
          read.status === "ok"
            ? { ok: true, configured: true, publicUrl: read.resolved.publicUrl, hostname: read.resolved.hostname, tunnelName: read.resolved.tunnelName ?? null, tunnelId: read.resolved.tunnelId ?? null, credentialsFile: read.resolved.credentialsFile }
            : read.status === "malformed"
              ? { ok: false, configured: true, error: read.error, file: machineTunnelFile() }
              : { ok: true, configured: false, file: machineTunnelFile() }
        )
      );
      return;
    }
    if (read.status === "ok") {
      check(`Machine fixed address: ${read.resolved.publicUrl}`);
      if (read.resolved.tunnelName) say(`Tunnel: ${read.resolved.tunnelName}`);
      say(`Credentials: ${read.resolved.credentialsFile}`);
    } else if (read.status === "malformed") {
      cross(read.error);
      process.exitCode = 1;
    } else {
      say("No machine fixed address configured (tunnel.json missing).");
    }
  });

tunnelCmd
  .command("set")
  .description("Configure the machine-wide fixed address (tunnel.json)")
  .requiredOption("--public-url <url>", "fixed public base URL, e.g. https://c2c.example.com")
  .option("--tunnel-name <name>", "named tunnel name")
  .option("--tunnel-id <id>", "named tunnel UUID (preferred run target)")
  .requiredOption("--credentials-file <path>", "tunnel credentials JSON for this tunnel")
  .option("--json", "machine-readable output", false)
  .action((opts: { publicUrl: string; tunnelName?: string; tunnelId?: string; credentialsFile: string; json: boolean }) => {
    try {
      let publicUrl: string;
      try {
        const parsed = new URL(opts.publicUrl);
        if (parsed.protocol !== "https:" || (parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
          throw new Error("bad url");
        }
        publicUrl = parsed.origin;
      } catch {
        throw new Error("--public-url must be an https base URL without a path, e.g. https://c2c.example.com");
      }
      if (!opts.tunnelName && !opts.tunnelId) {
        throw new Error("Provide --tunnel-name <name> or --tunnel-id <uuid>");
      }
      const credentialsFile = path.resolve(opts.credentialsFile);
      let credentialsOk = false;
      try {
        credentialsOk = fs.statSync(credentialsFile).isFile() && fs.accessSync(credentialsFile, fs.constants.R_OK) === undefined;
      } catch {
        credentialsOk = false;
      }
      if (!credentialsOk) throw new Error(`Tunnel credentials file not found: ${credentialsFile}`);
      const resolved = parseMachineTunnelConfig({
        mode: "cloudflare-named",
        publicUrl,
        tunnelName: opts.tunnelName,
        tunnelId: opts.tunnelId,
        credentialsFile,
      });
      if (!resolved) throw new Error("Invalid machine tunnel configuration");
      writeMachineTunnelConfig({
        mode: "cloudflare-named",
        publicUrl: resolved.publicUrl,
        tunnelName: resolved.tunnelName,
        tunnelId: resolved.tunnelId,
        credentialsFile: resolved.credentialsFile,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, effectiveSource: "machine", restartRequired: true, publicUrl: resolved.publicUrl }));
        return;
      }
      check(`Machine fixed address saved: ${resolved.publicUrl}`);
      say("Restart the host to apply it (c2c restart -w <workspace>).");
    } catch (error) {
      handleCliError(error, opts.json);
      process.exitCode = 1;
    }
  });

tunnelCmd
  .command("unset")
  .description("Remove the machine-wide fixed address; the host falls back to a Quick Tunnel")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    clearMachineTunnelConfig();
    if (opts.json) say(JSON.stringify({ ok: true, effectiveSource: "unset", restartRequired: true }));
    else check("Machine fixed address removed (host falls back to a Quick Tunnel).");
  });

// ---------------------------------------------------------------- error handling

function fail(error: unknown): void {
  cross(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

process.on("unhandledRejection", (reason) => fail(reason));

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
