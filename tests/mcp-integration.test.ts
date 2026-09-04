import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Host } from "../src/host/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { readAuditEntries } from "../src/execution/audit.js";
import { MCP_CAPABILITIES, MCP_EXECUTION_RECORD_TEMPLATE, MCP_AUDIT_RESOURCE_URI } from "../src/mcp/server.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git, isolateStateDir, startTestHost } from "./helpers.js";

let root: string;
let stateDir: string;
let host: Host;
let client: Client;
let accessToken: string;

function context() {
  const context = host.registry.list()[0];
  if (!context) throw new Error("no workspace registered on host");
  return context;
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

beforeAll(async () => {
  stateDir = isolateStateDir();
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { react: "^19.0.0" } }));
  write(root, ".env", "API_KEY=supersecret\n");
  // an uncommitted change so git_diff has content
  write(root, "src/index.ts", "export const answer = 43; // changed\n");

  host = await startTestHost({ workspaceRoot: root });
  const tokens = context().authStore.issueTokens({
    clientId: "it-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
  });
  accessToken = tokens.accessToken;

  client = new Client({ name: "c2c-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${host.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await host.close();
  cleanup(root);
  cleanup(stateDir);
});

describe("MCP tools over Streamable HTTP", () => {
  it("lists exactly the advertised read-only tools (capabilities match reality)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...MCP_CAPABILITIES.tools].sort());
    // no write tools, ever
    for (const forbidden of ["write_file", "delete_file", "execute_shell", "git_commit", "install_package"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("workspace_info returns identity and project detection", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const info = jsonOf<{ workspaceId: string; projectType: string; frameworks: string[]; git: { isRepo: boolean; branch: string } }>(result);
    expect(info.workspaceId).toBe(context().workspace.id);
    expect(info.projectType).toBe("node");
    expect(info.frameworks).toContain("React");
    expect(info.git.isRepo).toBe(true);
    expect(info.git.branch).toBe("main");
  });

  it("read_file returns hello.txt", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const file = jsonOf<{ content: string; totalLines: number }>(result);
    expect(file.content).toContain("Hello from Codex with ChatGPT!");
  });

  it("read_file denies .env with ACCESS_DENIED_SENSITIVE_FILE and no content", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
    expect(textOf(result)).not.toContain("supersecret");
  });

  it("read_file denies paths outside the workspace", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("list_directory lists the tree", async () => {
    const result = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 2 } });
    const listing = jsonOf<{ entries: { path: string }[] }>(result);
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
  });

  it("search_workspace finds matches", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "answer" } });
    const search = jsonOf<{ matches: { path: string; line: number }[] }>(result);
    expect(search.matches.some((match) => match.path === "src/index.ts")).toBe(true);
  });

  it("git_status reports the dirty file", async () => {
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const status = jsonOf<{ isRepo: boolean; unstaged: { path: string }[] }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
  });

  it("git_diff shows the change", async () => {
    const result = await client.callTool({ name: "git_diff", arguments: { mode: "unstaged" } });
    const diff = jsonOf<{ diff: string; hasMore: boolean }>(result);
    expect(diff.diff).toContain("answer = 43");
    expect(diff.hasMore).toBe(false);
  });

  it("git_diff paginates large diffs", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `content line ${i}`).join("\n");
    write(root, "big-change.txt", big);
    git(root, "add", "big-change.txt");
    const first = jsonOf<{ hasMore: boolean; nextOffset: number; totalBytes: number; returnedBytes: number }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged", max_bytes: 4096 } })
    );
    expect(first.hasMore).toBe(true);
    expect(first.returnedBytes).toBeLessThanOrEqual(4096);
    const second = jsonOf<{ offset: number; diff: string }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", max_bytes: 4096, offset: first.nextOffset },
      })
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
    git(root, "reset", "big-change.txt");
  });

  it("execution_summary and test_status read harness records, including slugs", async () => {
    appendExecutionRecord(context().workspace.id, {
      taskId: "c2c_test1",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "27 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
      slug: "fix-tunnel-parse",
    });
    const summary = jsonOf<{ records: { taskId: string; slug?: string }[] }>(
      await client.callTool({ name: "execution_summary", arguments: {} })
    );
    expect(summary.records[0].taskId).toBe("c2c_test1");
    expect(summary.records[0].slug).toBe("fix-tunnel-parse");

    const status = jsonOf<{ available: boolean; tests: string; slug?: string }>(
      await client.callTool({ name: "test_status", arguments: {} })
    );
    expect(status.available).toBe(true);
    expect(status.tests).toBe("27 passed");
    expect(status.slug).toBe("fix-tunnel-parse");
  });

  it("enforces scopes per tool", async () => {
    const limited = context().authStore.issueTokens({ clientId: "limited", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${host.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    const denied = await limitedClient.callTool({ name: "git_diff", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    const allowed = await limitedClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowed.isError ?? false).toBe(false);
    await limitedClient.close();
  });

  it("git_diff over MCP excludes sensitive files like .npmrc and service-account*.json", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=supersecret-npm-token\n");
    write(root, "service-account-test.json", '{"private_key": "supersecret-sa-key"}\n');
    write(root, "src/visible.ts", "export const visible = 'safe-change';\n");

    git(root, "add", "-f", ".npmrc", "service-account-test.json", "src/visible.ts");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).toContain("safe-change");
    expect(result.diff).not.toContain("supersecret-npm-token");
    expect(result.diff).not.toContain("supersecret-sa-key");

    git(root, "rm", "-f", "--cached", ".npmrc", "service-account-test.json", "src/visible.ts");
  });

  it("git_diff over MCP blocks sensitive-to-safe renames from leaking original content", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=mcp-secret-token-123\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add secret to rename");

    git(root, "mv", ".npmrc", "public_harmless.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("mcp-secret-token-123");
    expect(result.diff).not.toContain("public_harmless.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("git_diff over MCP with path='src' blocks cross-boundary rename leaks from root secrets", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=root-mcp-scoped-secret\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add root secret for scoped test");

    // Rename root .npmrc to src/public.txt
    git(root, "mv", ".npmrc", "src/public.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", path: "src" },
      })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("root-mcp-scoped-secret");
    expect(result.diff).not.toContain("src/public.txt");

    git(root, "reset", "--hard", "HEAD");
  });
});

describe("execution record resources", () => {
  it("advertises the execution record template", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toContain(MCP_EXECUTION_RECORD_TEMPLATE);
  });

  it("returns all iterations of a task by id", async () => {
    appendExecutionRecord(context().workspace.id, {
      taskId: "c2c_res1",
      iteration: 1,
      changedFiles: ["a.ts"],
      tests: null,
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
      state: "INIT",
      goal: "resource flow check",
      slug: "res-check",
    });
    appendExecutionRecord(context().workspace.id, {
      taskId: "c2c_res1",
      iteration: 2,
      changedFiles: 3,
      tests: "5 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
      state: "EXECUTED",
    });

    const result = await client.readResource({ uri: "c2c://execution/c2c_res1/record" });
    const text = (result.contents as { text: string }[])[0].text;
    const body = JSON.parse(text) as { taskId: string; slug?: string; records: { iteration: number }[] };
    expect(body.taskId).toBe("c2c_res1");
    expect(body.slug).toBe("res-check");
    expect(body.records.map((record) => record.iteration)).toEqual([1, 2]);
  });

  it("rejects unknown task ids", async () => {
    await expect(client.readResource({ uri: "c2c://execution/c2c_missing/record" })).rejects.toThrow(/UNKNOWN_TASK/);
  });

  it("enforces the execution.read scope on resources", async () => {
    const limited = context().authStore.issueTokens({ clientId: "no-exec", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "no-exec", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${host.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    await expect(limitedClient.readResource({ uri: "c2c://execution/c2c_res1/record" })).rejects.toThrow(/INSUFFICIENT_SCOPE/);
    await limitedClient.close();
  });
});

describe("read audit (per-identity ledger)", () => {
  it("records which clientId read what", async () => {
    const wsId = context().workspace.id;
    const before = readAuditEntries(wsId, 1000).length;
    await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const entries = readAuditEntries(wsId, 1000);
    expect(entries.length).toBeGreaterThan(before);
    const last = entries[entries.length - 1];
    expect(last.clientId).toBe("it-client");
    expect(last.tool).toBe("read_file");
    expect(last.detail?.path).toBe("hello.txt");
  });

  it("records denied attempts with the missing scope", async () => {
    const limited = context().authStore.issueTokens({ clientId: "snooper", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "snooper", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${host.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    await limitedClient.callTool({ name: "git_status", arguments: {} });
    await limitedClient.close();
    const denied = readAuditEntries(context().workspace.id, 1000).find(
      (entry) => entry.clientId === "snooper" && entry.tool === "git_status"
    );
    expect(denied?.detail?.denied).toBe(true);
    expect(denied?.detail?.scope).toBe("git.read");
  });

  it("exposes recent audit entries as a resource", async () => {
    const result = await client.readResource({ uri: MCP_AUDIT_RESOURCE_URI });
    const body = JSON.parse((result.contents as { text: string }[])[0].text) as {
      entries: { clientId: string; tool: string }[];
    };
    expect(body.entries.some((entry) => entry.clientId === "it-client" && entry.tool === "read_file")).toBe(true);
  });
});

describe("structured outputs (upstream #238/#322)", () => {
  // The SDK validates every structuredContent against the tool's outputSchema
  // server-side; this proves the typed output actually reaches the client.
  const cases: Array<{
    tool: string;
    args?: Record<string, unknown>;
    check: (data: Record<string, unknown>) => void;
  }> = [
    { tool: "workspace_info", check: (d) => expect(d.workspaceId).toBe(context().workspace.id) },
    { tool: "list_directory", args: { path: "." }, check: (d) => expect(Array.isArray(d.entries)).toBe(true) },
    { tool: "read_file", args: { path: "hello.txt" }, check: (d) => expect(typeof d.content).toBe("string") },
    { tool: "search_workspace", args: { query: "answer" }, check: (d) => expect(d.engine).toBeDefined() },
    { tool: "git_status", check: (d) => expect(d.isRepo).toBe(true) },
    { tool: "git_diff", check: (d) => expect(typeof d.diff).toBe("string") },
    { tool: "test_status", check: (d) => expect(typeof d.available).toBe("boolean") },
    { tool: "execution_summary", check: (d) => expect(Array.isArray(d.records)).toBe(true) },
  ];
  for (const entry of cases) {
    it(`${entry.tool} returns schema-backed structuredContent`, async () => {
      const result = await client.callTool({ name: entry.tool, arguments: entry.args ?? {} });
      expect(result.isError ?? false).toBe(false);
      const data = result.structuredContent as Record<string, unknown>;
      expect(data).toBeDefined();
      entry.check(data);
    });
  }
});

describe("admin capabilities advertisement", () => {
  it("advertises the MCP tool + resource surface on /admin/info", async () => {
    const response = await fetch(`http://127.0.0.1:${host.port}/admin/info`, {
      headers: { authorization: `Bearer ${host.adminToken}` },
    });
    expect(response.status).toBe(200);
    const info = (await response.json()) as {
      capabilities?: { schemaVersion: number; tools: string[]; resources: string[] };
    };
    expect(info.capabilities?.tools).toEqual(MCP_CAPABILITIES.tools);
    expect(info.capabilities?.resources).toContain(MCP_EXECUTION_RECORD_TEMPLATE);
    expect(info.capabilities?.schemaVersion).toBe(2);
  });

  it("never serves the admin surface without the loopback + admin token", async () => {
    const noToken = await fetch(`http://127.0.0.1:${host.port}/admin/info`);
    expect(noToken.status).toBe(404);
  });
});
