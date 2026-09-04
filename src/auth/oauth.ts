import { Router, type Request, type Response, urlencoded, json } from "express";
import { randomBytes } from "node:crypto";
import { AuthStore, SUPPORTED_SCOPES, base64UrlSha256, filterScopes, safeEqual } from "./store.js";
import type { PairingManager } from "../pairing/manager.js";
import type { Logger } from "../logger/index.js";
import { PRODUCT_NAME } from "../version.js";

/** One hosted workspace, as seen by the host-level OAuth/MCP routes. */
export interface WorkspaceEntryView {
  workspaceId: string;
  workspaceName: string;
  pairing: PairingManager;
  store: AuthStore;
}

export interface OAuthDeps {
  /** Live workspace contexts; the pairing code selects the workspace. */
  entries: () => WorkspaceEntryView[];
  /** Canonical public resource (e.g. https://c2c.example.com/mcp). */
  resource: () => string;
  getBaseUrl: (req: Request) => string;
  logger: Logger;
}

interface PendingAuthRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
  attemptsLeft?: number;
}

interface PendingClient {
  clientName?: string;
  redirectUris: string[];
  resource?: string;
  createdAt: number;
}

const MAX_PENDING_REQUESTS = 100;
const MAX_PENDING_CLIENTS = 100;
/** Machine-global wrong-code budget (per minute). Session caps still apply. */
const GLOBAL_FAIL_LIMIT = 10;
const GLOBAL_FAIL_WINDOW_MS = 60_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
    return true;
  }
  return false;
}

function authorizationServerMetadata(base: string): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SUPPORTED_SCOPES],
  };
}

function protectedResourceMetadata(base: string): Record<string, unknown> {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: PRODUCT_NAME,
  };
}

function htmlHeaders(res: Response): void {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function pairingPage(opts: {
  requestId: string;
  workspaceName: string | null;
  scopes: string[];
  error?: string;
}): string {
  const scopeLabels: Record<string, string> = {
    "workspace.read": "Read files in this workspace",
    "workspace.search": "Search this workspace",
    "git.read": "Read git status and diffs",
    "execution.read": "Read execution summaries",
    offline_access: "Stay connected between sessions",
  };
  const scopeList = opts.scopes
    .map((scope) => `<li>${escapeHtml(scopeLabels[scope] ?? scope)}</li>`)
    .join("");
  const errorHtml = opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>` : "";
  const workspaceLine = opts.workspaceName
    ? `Access to workspace <strong>${escapeHtml(opts.workspaceName)}</strong> (read-only):`
    : `Access to the workspace whose pairing code you enter (read-only):`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(PRODUCT_NAME)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh;
         margin: 0; background: #f5f5f7; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } .card { background: #1c1c1e !important; } }
  .card { background: #fff; border-radius: 16px; padding: 40px; max-width: 420px; width: 90%;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #86868b; font-size: 14px; margin: 0 0 20px; }
  ul { font-size: 13px; color: #6e6e73; padding-left: 18px; margin: 0 0 24px; }
  li { margin-bottom: 4px; }
  input[type=text] { width: 100%; box-sizing: border-box; font-size: 24px; letter-spacing: 4px;
          text-align: center; text-transform: uppercase; padding: 12px; border: 1.5px solid #d2d2d7;
          border-radius: 10px; font-family: ui-monospace, monospace; background: transparent; color: inherit; }
  input[type=text]:focus { outline: none; border-color: #0071e3; }
  button { width: 100%; margin-top: 16px; padding: 12px; font-size: 16px; border: 0; border-radius: 10px;
           background: #0071e3; color: #fff; cursor: pointer; }
  button:hover { background: #0077ed; }
  .error { color: #d70015; font-size: 13px; margin: 12px 0 0; }
  .hint { color: #86868b; font-size: 12px; margin-top: 16px; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>${escapeHtml(PRODUCT_NAME)}</h1>
  <p class="sub">Your coding agent is requesting ${workspaceLine}</p>
  <ul>${scopeList}</ul>
  <form method="POST" action="authorize">
    <input type="hidden" name="request_id" value="${escapeHtml(opts.requestId)}">
    <input type="text" name="pairing_code" id="pairing_code" placeholder="XXXX-XXXX"
           autocomplete="one-time-code" autofocus maxlength="9" required>
    ${errorHtml}
    <button type="submit">Connect</button>
  </form>
  <p class="hint">The pairing code was generated by your coding agent on this computer.<br>It expires in a few minutes.</p>
</div>
</body>
</html>`;
}

export function createOAuthRouter(deps: OAuthDeps): Router {
  const router = Router();
  const pendingRequests = new Map<string, PendingAuthRequest>();
  /**
   * Clients registered before a pairing code chose a workspace. Materialized
   * into the chosen workspace's AuthStore at code creation. This is the
   * pre-auth registry — bounded, in-memory, never persisted.
   */
  const pendingClients = new Map<string, PendingClient>();
  let globalFailBucket: { count: number; resetAt: number } | null = null;

  const prunePending = (): void => {
    const now = Date.now();
    for (const [id, request] of pendingRequests) {
      if (now > request.expiresAt) pendingRequests.delete(id);
    }
    for (const [id, client] of pendingClients) {
      if (now - client.createdAt > 30 * 60_000) pendingClients.delete(id);
    }
  };

  const globalFailAllowed = (): boolean =>
    !globalFailBucket || Date.now() > globalFailBucket.resetAt || globalFailBucket.count < GLOBAL_FAIL_LIMIT;
  const registerGlobalFail = (): void => {
    const now = Date.now();
    if (!globalFailBucket || now > globalFailBucket.resetAt) {
      globalFailBucket = { count: 1, resetAt: now + GLOBAL_FAIL_WINDOW_MS };
      return;
    }
    globalFailBucket.count++;
  };

  const html = (res: Response, status: number, body: string): void => {
    htmlHeaders(res);
    res.status(status).type("html").send(body);
  };

  const sendPairingPage = (res: Response, request: PendingAuthRequest, error?: string): void => {
    const entries = deps.entries();
    html(
      res,
      error ? 401 : 200,
      pairingPage({
        requestId: request.id,
        workspaceName: entries.length === 1 ? entries[0].workspaceName : null,
        scopes: request.scopes,
        error,
      })
    );
  };

  // ---- Discovery metadata -------------------------------------------------

  const asMetadataHandler = (_req: Request, res: Response): void => {
    res.json(authorizationServerMetadata(deps.getBaseUrl(_req)));
  };
  const prMetadataHandler = (_req: Request, res: Response): void => {
    res.json(protectedResourceMetadata(deps.getBaseUrl(_req)));
  };
  router.get("/.well-known/oauth-authorization-server", asMetadataHandler);
  router.get("/.well-known/oauth-authorization-server/mcp", asMetadataHandler);
  router.get("/.well-known/openid-configuration", asMetadataHandler);
  router.get("/.well-known/oauth-protected-resource", prMetadataHandler);
  router.get("/.well-known/oauth-protected-resource/mcp", prMetadataHandler);

  // ---- Dynamic Client Registration (RFC 7591) ------------------------------
  // Pre-auth: the workspace is chosen later by the pairing code, so the
  // client lands in a bounded in-memory registry and is materialized into
  // the chosen workspace's store when the code is issued.

  router.post("/oauth/register", json({ limit: "32kb" }), (req, res) => {
    prunePending();
    const body = req.body as { client_name?: string; redirect_uris?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (
      redirectUris.length === 0 ||
      !redirectUris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri))
    ) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be https URLs (or http://localhost for development)",
      });
      return;
    }
    if (pendingClients.size >= MAX_PENDING_CLIENTS) {
      res.status(429).json({ error: "temporarily_unavailable", error_description: "Too many pending registrations" });
      return;
    }
    const client: PendingClient = {
      clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : undefined,
      redirectUris: redirectUris as string[],
      resource: deps.resource(),
      createdAt: Date.now(),
    };
    const clientId = `c2c_client_${randomBytes(12).toString("base64url")}`;
    pendingClients.set(clientId, client);
    deps.logger.info(`Registered OAuth client ${clientId} (${client.clientName ?? "unnamed"})`);
    res.status(201).json({
      client_id: clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  /** Materialize a pending (or already-paired) client into a workspace store. */
  const ensureClient = (entry: WorkspaceEntryView, clientId: string): boolean => {
    if (entry.store.getClient(clientId)) return true;
    const pending = pendingClients.get(clientId);
    if (!pending) return false;
    entry.store.ensureClient({
      clientId,
      clientName: pending.clientName,
      redirectUris: pending.redirectUris,
      resource: pending.resource,
      createdAt: new Date(pending.createdAt).toISOString(),
    });
    pendingClients.delete(clientId);
    return true;
  };

  // ---- Authorization endpoint ----------------------------------------------

  router.get("/oauth/authorize", (req, res) => {
    prunePending();
    const query = req.query as Record<string, string | undefined>;
    const known =
      (query.client_id ? pendingClients.has(query.client_id) : false) ||
      deps.entries().some((entry) => entry.store.getClient(query.client_id ?? ""));
    if (!known) {
      html(res, 400, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(PRODUCT_NAME)}</title></head><body><p>Unknown client. Please reconnect from your coding agent.</p></body></html>`);
      return;
    }
    const clientRedirectUris =
      query.client_id && pendingClients.has(query.client_id)
        ? pendingClients.get(query.client_id)!.redirectUris
        : deps
            .entries()
            .map((entry) => entry.store.getClient(query.client_id ?? ""))
            .find((client) => client !== undefined)?.redirectUris ?? [];
    const redirectUri = query.redirect_uri;
    if (!redirectUri || !clientRedirectUris.includes(redirectUri)) {
      html(res, 400, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(PRODUCT_NAME)}</title></head><body><p>Invalid redirect_uri.</p></body></html>`);
      return;
    }
    const fail = (error: string, description: string): void => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (query.state) url.searchParams.set("state", query.state);
      res.redirect(url.toString());
    };
    if (query.response_type !== "code") {
      fail("unsupported_response_type", "Only response_type=code is supported");
      return;
    }
    if (!query.code_challenge || query.code_challenge_method !== "S256") {
      fail("invalid_request", "PKCE with S256 is required");
      return;
    }
    const scopes = filterScopes(query.scope);
    if (!scopes) {
      fail("invalid_scope", "The request contains unsupported scopes");
      return;
    }
    if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
      html(res, 429, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(PRODUCT_NAME)}</title></head><body><p>Too many pending authorization requests. Please retry in a minute.</p></body></html>`);
      return;
    }
    const request: PendingAuthRequest = {
      id: randomBytes(16).toString("hex"),
      clientId: query.client_id!,
      redirectUri,
      scopes,
      state: query.state,
      codeChallenge: query.code_challenge,
      resource: query.resource ?? deps.resource(),
      expiresAt: Date.now() + 10 * 60_000,
    };
    pendingRequests.set(request.id, request);
    sendPairingPage(res, request);
  });

  router.post("/oauth/authorize", urlencoded({ extended: false }), (req, res) => {
    prunePending();
    const body = req.body as { request_id?: string; pairing_code?: string };
    const request = body.request_id ? pendingRequests.get(body.request_id) : undefined;
    if (!request) {
      html(res, 400, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(PRODUCT_NAME)}</title></head><body><p>This authorization request has expired. Please reconnect from your coding agent.</p></body></html>`);
      return;
    }
    if (!globalFailAllowed()) {
      sendPairingPage(res, request, "Too many attempts. Please wait a minute and try again.");
      return;
    }
    const normalized = body.pairing_code ?? "";
    // Non-mutating match across workspaces; only the winning workspace's
    // manager destructively verifies. Wrong codes hit the global budget.
    const hit = deps
      .entries()
      .map((entry) => ({ entry, matched: entry.pairing.match(normalized) }))
      .find((h) => h.matched !== null);
    if (!hit) {
      registerGlobalFail();
      request.attemptsLeft = (request.attemptsLeft ?? 5) - 1;
      if (request.attemptsLeft <= 0) {
        pendingRequests.delete(request.id);
        sendPairingPage(res, request, "Too many incorrect attempts. Please reconnect and ask your coding agent for a new pairing code.");
        return;
      }
      sendPairingPage(res, request, `Incorrect pairing code. ${request.attemptsLeft} attempts left.`);
      return;
    }
    const verdict = hit.entry.pairing.verify(normalized, undefined);
    if (!verdict.ok) {
      sendPairingPage(res, request, "This pairing code has expired. Ask your coding agent to generate a new one.");
      return;
    }
    // Materialize the client into the chosen workspace's store.
    const materialized = ensureClient(hit.entry, request.clientId);
    if (!materialized) {
      html(res, 400, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(PRODUCT_NAME)}</title></head><body><p>Unknown client. Please reconnect from your coding agent.</p></body></html>`);
      return;
    }
    pendingRequests.delete(request.id);
    const code = hit.entry.store.createAuthorizationCode({
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes: request.scopes,
      pairingSessionId: verdict.sessionId,
      resource: request.resource,
    });
    deps.logger.info(
      `Pairing verified for workspace ${hit.entry.workspaceName}; issued authorization code for client ${request.clientId}`
    );
    const url = new URL(request.redirectUri);
    url.searchParams.set("code", code);
    if (request.state) url.searchParams.set("state", request.state);
    res.redirect(url.toString());
  });

  // ---- Token endpoint --------------------------------------------------------

  router.post("/oauth/token", urlencoded({ extended: false }), json({ limit: "32kb" }), (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const { code, code_verifier: codeVerifier, client_id: clientId, redirect_uri: redirectUri } = body;
      if (!code || !codeVerifier || !clientId) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      // The code lives in the store of the workspace the pairing selected.
      let issued: ReturnType<AuthStore["issueTokens"]> | null = null;
      for (const entry of deps.entries()) {
        const record = entry.store.consumeAuthorizationCode(code);
        if (!record) continue;
        if (record.clientId !== clientId) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        if (redirectUri && redirectUri !== record.redirectUri) {
          res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
          return;
        }
        if (!safeEqual(base64UrlSha256(codeVerifier), record.codeChallenge)) {
          deps.logger.warn("PKCE verification failed at token endpoint");
          res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
        issued = entry.store.issueTokens({
          clientId,
          scopes: record.scopes,
          workspaceId: entry.workspaceId,
          resource: record.resource ?? deps.resource(),
        });
        break;
      }
      if (!issued) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      deps.logger.info(`Issued access token for client ${clientId}`);
      res.json({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken ?? undefined,
        scope: issued.scopes.join(" "),
      });
      return;
    }

    if (grantType === "refresh_token") {
      const { refresh_token: refreshToken, client_id: clientId } = body;
      if (!refreshToken || !clientId) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      // Only the owning store holds the token/tombstone; replay detection
      // (family revocation) runs inside that store.
      let result: ReturnType<AuthStore["refresh"]> | null = null;
      for (const entry of deps.entries()) {
        result = entry.store.refresh(refreshToken, clientId);
        if (result.ok) {
          deps.logger.info(`Rotated refresh token for client ${clientId} (workspace ${entry.workspaceId})`);
          res.json({
            access_token: result.tokens.accessToken,
            token_type: "Bearer",
            expires_in: result.tokens.expiresIn,
            refresh_token: result.tokens.refreshToken ?? undefined,
            scope: result.tokens.scopes.join(" "),
          });
          return;
        }
      }
      res.status(400).json({ error: result ? result.reason : "invalid_grant" });
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  // ---- Revocation (RFC 7009) ---------------------------------------------------

  router.post("/oauth/revoke", urlencoded({ extended: false }), (req, res) => {
    const body = req.body as { token?: string };
    if (body.token) {
      for (const entry of deps.entries()) {
        if (entry.store.revokeToken(body.token)) break;
      }
    }
    res.status(200).json({});
  });

  return router;
}

