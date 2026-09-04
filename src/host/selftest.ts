import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureHostForWorkspace, fetchJson } from "./manager.js";
import { Workspace } from "../workspace/manager.js";
import { MCP_CAPABILITIES } from "../mcp/server.js";
import { PRODUCT_NAME } from "../version.js";

/**
 * `c2c selftest` (§13.5, oracle --dry-run inspired): exercise the EXACT
 * connector path end-to-end — tunnel base URL → dynamic client registration →
 * pairing code → PKCE exchange → authorized MCP reads — with a throwaway
 * client, without touching the user's real ChatGPT connector. Admin calls
 * always go over loopback (the admin surface is loopback-only by design);
 * only OAuth + MCP traffic goes through the public URL under test.
 */

export interface SelftestStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface SelftestResult {
  ok: boolean;
  base: string | null;
  mcpUrl: string | null;
  steps: SelftestStep[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function fetchWithTimeout(url: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export async function runSelftest(opts: {
  workspaceRoot: string;
  /** Test the loopback host directly instead of the public tunnel URL. */
  loopback?: boolean;
  timeoutMs?: number;
}): Promise<SelftestResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const steps: SelftestStep[] = [];
  const step = (step: string, ok: boolean, detail: string): void => {
    steps.push({ step, ok, detail });
  };
  const workspace = new Workspace(opts.workspaceRoot);

  // 1. Host up + workspace registered -------------------------------------
  let port: number;
  let adminToken: string;
  let publicUrl: string | null;
  try {
    const { host } = await ensureHostForWorkspace(opts.workspaceRoot);
    port = host.port;
    adminToken = host.adminToken;
    const info = await fetchJson<{ publicUrl: string | null }>(port, "/admin/info", {
      token: adminToken,
      timeoutMs,
    });
    if (info.status !== 200) throw new Error(`/admin/info returned ${info.status}`);
    publicUrl = info.data.publicUrl ?? null;
    step("host", true, `running on 127.0.0.1:${port}, workspace ${workspace.name} registered`);
  } catch (error) {
    step("host", false, (error as Error).message);
    return { ok: false, base: null, mcpUrl: null, steps };
  }

  // 2. Public base URL ------------------------------------------------------
  const base = opts.loopback ? `http://127.0.0.1:${port}` : publicUrl;
  if (!base) {
    step("tunnel", false, "no public URL — run `c2c doctor --fix` or `c2c setup` first (or use --loopback)");
    return { ok: false, base: null, mcpUrl: null, steps };
  }
  step("tunnel", true, `testing against ${base} (--loopback tests the host directly)`);

  // 3. Pairing code (loopback admin surface) --------------------------------
  let pairingCode: string;
  try {
    const pairing = await fetchJson<{ code: string }>(port, "/admin/pairing", {
      method: "POST",
      token: adminToken,
      body: { workspaceId: workspace.id },
      timeoutMs,
    });
    if (pairing.status !== 200 || !pairing.data.code) {
      throw new Error(pairing.data.message ?? `pairing failed (${pairing.status})`);
    }
    pairingCode = pairing.data.code;
    step("pairing", true, "pairing code created");
  } catch (error) {
    step("pairing", false, (error as Error).message);
    return { ok: false, base, mcpUrl: null, steps };
  }

  // 4. Dynamic client registration ------------------------------------------
  const redirectUri = "http://127.0.0.1:1/selftest-callback";
  let clientId: string;
  try {
    const response = await fetchWithTimeout(
      `${base}/oauth/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: `${PRODUCT_NAME} selftest`, redirect_uris: [redirectUri] }),
      },
      timeoutMs
    );
    const body = (await response.json()) as { client_id?: string };
    if (response.status !== 201 || !body.client_id) throw new Error(`DCR returned ${response.status}`);
    clientId = body.client_id;
    step("dcr", true, `registered ${clientId}`);
  } catch (error) {
    step("dcr", false, (error as Error).message);
    return { ok: false, base, mcpUrl: null, steps };
  }

  // 5. Authorize: pairing page -> submit code -> redirect with auth code ------
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let authCode: string;
  try {
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set(
      "scope",
      "workspace.read workspace.search git.read execution.read"
    );
    const page = await fetchWithTimeout(authorizeUrl, { redirect: "manual" }, timeoutMs);
    const html = await page.text();
    const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
    if (!requestId) throw new Error(`authorize page missing request_id (status ${page.status})`);

    const submit = await fetchWithTimeout(
      `${base}/oauth/authorize`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
        redirect: "manual",
      },
      timeoutMs
    );
    const location = submit.headers.get("location");
    const code = location ? new URL(location).searchParams.get("code") : null;
    if (submit.status !== 302 || !code) throw new Error(`pairing submit returned ${submit.status}`);
    authCode = code;
    step("authorize", true, "pairing accepted, authorization code issued");
  } catch (error) {
    step("authorize", false, (error as Error).message);
    return { ok: false, base, mcpUrl: null, steps };
  }

  // 6. PKCE token exchange -----------------------------------------------------
  let accessToken: string;
  try {
    const response = await fetchWithTimeout(
      `${base}/oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }),
      },
      timeoutMs
    );
    const body = (await response.json()) as TokenResponse;
    if (response.status !== 200 || !body.access_token) {
      throw new Error(`token exchange returned ${response.status} (${body.error ?? "unknown"})`);
    }
    accessToken = body.access_token;
    step("token", true, "PKCE exchange ok (access token issued)");
  } catch (error) {
    step("token", false, (error as Error).message);
    return { ok: false, base, mcpUrl: null, steps };
  }

  // 7. Authorized MCP reads over the tested URL --------------------------------
  const mcpUrl = `${base}/mcp`;
  const client = new Client({ name: `${PRODUCT_NAME}-selftest`, version: "1.0.0" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    const missing = MCP_CAPABILITIES.tools.filter((name) => !names.has(name));
    if (missing.length > 0) throw new Error(`tool surface incomplete, missing: ${missing.join(", ")}`);
    step("tools", true, `${MCP_CAPABILITIES.tools.length} read-only tools present`);

    const info = await client.callTool({ name: "workspace_info", arguments: {} });
    if (info.isError) throw new Error("workspace_info failed");
    const infoBody = JSON.parse((info.content as { text: string }[])[0].text) as { workspaceId: string };
    if (infoBody.workspaceId !== workspace.id) throw new Error("workspace_info returned a different workspace");
    step("workspace_info", true, `identity confirmed (${workspace.name})`);

    const listing = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 1 } });
    if (listing.isError) throw new Error("list_directory failed");
    const entries = (JSON.parse((listing.content as { text: string }[])[0].text) as {
      entries: { path: string; type: string }[];
    }).entries;
    const probe = entries.find((entry) => entry.type === "file");
    if (probe) {
      const file = await client.callTool({ name: "read_file", arguments: { path: probe.path } });
      if (file.isError) throw new Error(`read_file failed on ${probe.path}`);
      step("read_file", true, `read ${probe.path}`);
    } else {
      step("read_file", true, "no file in workspace root to probe (listing worked)");
    }
  } catch (error) {
    step("mcp", false, (error as Error).message);
    await client.close().catch(() => undefined);
    return { ok: false, base, mcpUrl, steps };
  }
  await client.close().catch(() => undefined);

  // 8. Revocation actually cuts access ------------------------------------------
  try {
    await fetchWithTimeout(
      `${base}/oauth/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken }),
      },
      timeoutMs
    );
    const probe = await fetchWithTimeout(
      mcpUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      },
      timeoutMs
    );
    if (probe.status !== 401) throw new Error(`revoked token still accepted (${probe.status})`);
    step("revocation", true, "revoked token correctly rejected (401)");
  } catch (error) {
    step("revocation", false, (error as Error).message);
    return { ok: false, base, mcpUrl, steps };
  }

  return { ok: steps.every((entry) => entry.ok), base, mcpUrl, steps };
}
