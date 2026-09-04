import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { createOAuthRouter, type WorkspaceEntryView } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { effectiveTunnelState, resolveTunnelProvider } from "../tunnel/resolve.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import {
  clearHostState,
  writeHostState,
  type HostState,
  type HostWorkspaceRecord,
} from "./state.js";
import { WorkspaceRegistry, type WorkspaceSummary } from "./registry.js";
import { MCP_CAPABILITIES } from "../mcp/server.js";

export interface HostOptions {
  /** Initial workspace (from `c2c start` / `serve`). */
  workspaceRoot: string;
  logger?: Logger;
  /** Persist host state (disable in tests). */
  persist?: boolean;
  /** How long an empty host waits for the next registration before exiting. */
  idleGraceMs?: number;
  /** No ephemeral fallback: the fixed port IS the election primitive. */
  port?: number;
  host?: string;
  tunnelProvider?: TunnelProvider;
  pairingTtlMs?: number;
}

export interface Host {
  port: number;
  host: string;
  adminToken: string;
  instanceId: string;
  registry: WorkspaceRegistry;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  registerWorkspace(workspaceRoot: string): WorkspaceSummary;
  unregisterWorkspace(workspaceId: string): boolean;
  close(): Promise<void>;
}

export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is already in use`);
  }
}

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Timing-safe admin-token comparison: hash both sides to fixed-length
 * buffers first, so neither length nor content branches on the secret.
 */
function adminTokenMatches(presented: string, expected: string): boolean {
  const bufA = Buffer.from(sha256hex(presented));
  const bufB = Buffer.from(sha256hex(expected));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function startHost(opts: HostOptions): Promise<Host> {
  const logger = opts.logger ?? nullLogger;
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const persist = opts.persist !== false;
  const idleGraceMs = opts.idleGraceMs ?? 15_000;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const adminToken = `c2c_admin_${randomBytes(32).toString("base64url")}`;
  const instanceId = randomBytes(8).toString("hex");
  const registry = new WorkspaceRegistry({ pairingTtlMs: opts.pairingTtlMs });
  registry.register(opts.workspaceRoot);

  // Machine tunnel resolution: tunnel.json (fixed address) or Quick. A
  // malformed machine config throws — never silently serve a rotating URL.
  const tunnelOwner = { pid: process.pid, workspaceId: "__host__" };
  const resolvedTunnel = opts.tunnelProvider
    ? { source: "override" as const, provider: opts.tunnelProvider, configId: "override" }
    : resolveTunnelProvider("__host__", logger, tunnelOwner);
  let tunnel = resolvedTunnel.provider;
  let publicBaseUrl: string | null = null;
  let tunnelMode: HostState["tunnelMode"] =
    resolvedTunnel.source === "machine" ? "named" : resolvedTunnel.source === "quick" ? "quick" : "none";

  const app = express();
  app.disable("x-powered-by");
  // No `trust proxy`: public base URLs come from host tunnel state, and the
  // pairing limiter must not trust client-controlled forwarded headers.

  const entries = (): WorkspaceEntryView[] =>
    registry.list().map((context) => ({
      workspaceId: context.workspace.id,
      workspaceName: context.workspace.name,
      pairing: context.pairing,
      store: context.authStore,
    }));

  const resource = (): string =>
    `${publicBaseUrl ?? `http://${host}:${port}`}/mcp`;

  const getBaseUrl = (_req: Request): string =>
    publicBaseUrl ?? `http://${host}:${port}`;

  // ---- Health (liveness only — reveals nothing about workspaces) ----------

  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, status: "ok" });
  });

  // ---- OAuth (host-level; the pairing code selects the workspace) ---------

  app.use(
    createOAuthRouter({
      entries,
      resource,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP (one endpoint; the bearer token selects workspace + identity) --

  const mcpGuard = bearerAuth({ entries, resource, logger });
  app.all(
    "/mcp",
    express.json({ limit: "1mb" }),
    mcpGuard,
    (req: Request, res: Response) => {
      const entry = (req as Request & { c2cEntry?: WorkspaceEntryView }).c2cEntry;
      if (!entry) {
        res.status(403).json({ error: "forbidden", error_description: "No workspace context" });
        return;
      }
      const context = registry.get(entry.workspaceId);
      if (!context) {
        res.status(403).json({ error: "forbidden", error_description: "Workspace is not hosted here" });
        return;
      }
      const handler = createMcpHttpHandler(
        () => createMcpServer({ workspace: context.workspace, logger }),
        logger
      );
      void handler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only) ------------------------------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || !adminTokenMatches(token, adminToken)) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  let graceTimer: NodeJS.Timeout | null = null;
  let draining = false;
  let shutdownPromise: Promise<void> | null = null;

  function disarmGrace(): void {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }
  function armGrace(): void {
    if (draining || graceTimer) return;
    logger.info(`No workspaces hosted; exiting in ${Math.round(idleGraceMs / 1000)}s unless one registers`);
    graceTimer = setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, idleGraceMs);
    graceTimer.unref();
  }

  const persistState = (): void => {
    if (!persist) return;
    const state: HostState = {
      schemaVersion: 2,
      instanceId,
      pid: process.pid,
      port,
      adminToken,
      startedAt: startedAt,
      publicUrl: publicBaseUrl,
      tunnelMode,
      tunnelConfigId: resolvedTunnel.source === "machine" ? resolvedTunnel.configId : undefined,
      workspaces: registry.toRecords(),
    };
    writeHostState(state);
  };

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      instanceId,
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tunnelSource: resolvedTunnel.source,
      tunnelConfigId: resolvedTunnel.source === "machine" ? resolvedTunnel.configId : undefined,
      capabilities: MCP_CAPABILITIES,
      workspaces: registry.toRecords(),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/workspaces/register", adminGuard, express.json({ limit: "32kb" }), (req, res) => {
    const body = req.body as { workspaceRoot?: string };
    if (!body.workspaceRoot) {
      res.status(400).json({ error: "bad_request", message: "workspaceRoot is required" });
      return;
    }
    try {
      const { context } = registry.register(body.workspaceRoot);
      persistState();
      disarmGrace();
      logger.info(`Workspace ${context.workspace.name} registered (${context.workspace.id})`);
      res.json({
        workspaceId: context.workspace.id,
        workspaceName: context.workspace.name,
        workspaceRoot: context.workspace.root,
        port,
        publicUrl: publicBaseUrl,
      });
    } catch (error) {
      res.status(400).json({ error: "bad_workspace", message: (error as Error).message });
    }
  });

  app.post("/admin/workspaces/unregister", adminGuard, express.json({ limit: "32kb" }), (req, res) => {
    const body = req.body as { workspaceId?: string };
    const id = body.workspaceId ?? "";
    if (!registry.get(id)) {
      res.status(404).json({ error: "unknown_workspace", message: "Workspace is not hosted here" });
      return;
    }
    registry.unregister(id);
    persistState();
    logger.info(`Workspace ${id} unregistered (remaining: ${registry.size})`);
    if (registry.size === 0) armGrace();
    res.json({ removed: true, remaining: registry.size });
  });

  app.post("/admin/pairing", adminGuard, express.json({ limit: "32kb" }), (req, res) => {
    const body = req.body as { workspaceId?: string };
    const context = body.workspaceId
      ? registry.get(body.workspaceId)
      : registry.size === 1
        ? registry.list()[0]
        : undefined;
    if (!context) {
      res.status(400).json({
        error: "workspace_required",
        message: "Multiple workspaces are hosted; pass workspaceId",
      });
      return;
    }
    const session = context.pairing.create();
    logger.info(`Created pairing session for workspace ${context.workspace.name}`);
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.post("/admin/revoke-all", adminGuard, express.json({ limit: "32kb" }), (req, res) => {
    const body = req.body as { workspaceId?: string };
    const context = body.workspaceId
      ? registry.get(body.workspaceId)
      : registry.size === 1
        ? registry.list()[0]
        : undefined;
    if (!context) {
      res.status(400).json({ error: "workspace_required", message: "workspaceId is required" });
      return;
    }
    const count = context.authStore.revokeAll();
    context.pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count}) for workspace ${context.workspace.name}`);
    res.json({ revoked: count });
  });

  // Host-level tunnel reload: applying tunnel.json changes to the running
  // host without restarting it (or disconnecting any workspace).
  app.post("/admin/tunnel/reload", adminGuard, (_req, res) => {
    void (async () => {
      await tunnel.stop().catch(() => undefined);
      publicBaseUrl = null;
      tunnel = resolveTunnelProvider("__host__", logger, tunnelOwner).provider;
      const url = await tunnel.start(port);
      publicBaseUrl = url;
      persistState();
      return { url };
    })()
      .then((result) => res.json(result))
      .catch((error: Error) => {
        logger.error(`Tunnel reload failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  // ---- Listen: the fixed port is the election primitive. No fallback. ----

  const server: Server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, host);
    listener.once("listening", () => resolve(listener));
    listener.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") reject(new PortInUseError(port));
      else reject(error);
    });
  });

  const startedAt = new Date().toISOString();
  logger.info(`Host listening on ${host}:${port} for ${registry.size} workspace(s)`);

  // Machine tunnel start is best-effort at boot: the host is reachable on
  // loopback even if the tunnel fails, and /admin/tunnel/reload retries.
  void tunnel
    .start(port)
    .then((url) => {
      publicBaseUrl = url;
      tunnelMode = "named";
      persistState();
      logger.info(`Machine tunnel established: ${url}`);
    })
    .catch((error: Error) => {
      logger.error(`Machine tunnel failed to start: ${error.message}`);
      tunnelMode = resolvedTunnel.source === "machine" ? "named" : "quick";
      persistState();
    });

  // ---- Lifecycle: RUNNING -> IDLE_GRACE -> DRAINING -> CLOSED --------------
  // (graceTimer/draining are declared above; disarmGrace/armGrace hoisted)

  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      draining = true;
      disarmGrace();
      shutdownPromise = (async () => {
        await tunnel.stop().catch(() => undefined);
        (server as unknown as { closeIdleConnections?(): void }).closeIdleConnections?.();
        const closeSettled = new Promise<void>((resolve) => server.close(() => resolve()));
        const closedGracefully = await Promise.race([
          closeSettled.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_500).unref()),
        ]);
        if (persist) clearHostState();
        logger.info("Host stopped");
        if (!closedGracefully) {
          (server as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
          await closeSettled;
        }
      })();
    }
    return shutdownPromise;
  };

  persistState();

  return {
    port,
    host,
    adminToken,
    instanceId,
    registry,
    get tunnel(): TunnelProvider {
      return tunnel;
    },
    getPublicBaseUrl: () => publicBaseUrl,
    registerWorkspace: (workspaceRoot: string): WorkspaceSummary => {
      const { context } = registry.register(workspaceRoot);
      persistState();
      disarmGrace();
      return {
        workspaceId: context.workspace.id,
        workspaceName: context.workspace.name,
        workspaceRoot: context.workspace.root,
      };
    },
    unregisterWorkspace: (workspaceId: string): boolean => {
      const removed = registry.unregister(workspaceId);
      if (removed) {
        persistState();
        if (registry.size === 0) armGrace();
      }
      return removed;
    },
    close: shutdown,
  };
}
