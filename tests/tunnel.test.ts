import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { parseQuickTunnelUrl, verifyTunnelServesHost } from "../src/tunnel/cloudflared.js";
import { findBinary } from "../src/tunnel/detect.js";
import { SERVICE_NAME } from "../src/version.js";
import { normalizeNamedTunnelHostname } from "../src/tunnel/cloudflared-named.js";
import { hostnameSlug, parseZoneInput, suggestedNamedHostname } from "../src/tunnel/hostname.js";
import {
  chooseQuickTunnel,
  isBenignRouteError,
  parseCreatedTunnel,
  parseTunnelList,
  provisionNamedTunnel,
  type CloudflaredAccount,
} from "../src/tunnel/named-provision.js";
import { isNamedTunnelReady, needsTunnelChoice, readTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const stateDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;

afterEach(() => {
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe("https://random-words-here-1234.trycloudflare.com");
  });

  it("ignores unrelated lines", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
  });

  it("does not match non-trycloudflare hosts", () => {
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });

  it("never returns cloudflared's own API host as a tunnel URL (fail-closed #92)", () => {
    expect(parseQuickTunnelUrl("INF Registering tunnel at https://api.trycloudflare.com")).toBeNull();
    expect(parseQuickTunnelUrl("https://api.trycloudflare.com")).toBeNull();
    // a genuine random subdomain that merely contains "api" still works
    expect(parseQuickTunnelUrl("https://api-gateway-1a2b.trycloudflare.com")).toBe(
      "https://api-gateway-1a2b.trycloudflare.com"
    );
  });
});

describe("verifyTunnelServesHost (fail-closed startup)", () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  function healthServer(body: unknown): Promise<number> {
    return new Promise((resolve) => {
      server = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      });
      server.listen(0, "127.0.0.1", () => {
        resolve((server!.address() as { port: number }).port);
      });
    });
  }

  it("confirms when /health identifies this service", async () => {
    const port = await healthServer({ service: SERVICE_NAME, status: "ok" });
    expect(await verifyTunnelServesHost(`http://127.0.0.1:${port}`, { timeoutMs: 3_000 })).toBe(true);
  });

  it("rejects when /health identifies a different service", async () => {
    const port = await healthServer({ service: "something-else" });
    expect(await verifyTunnelServesHost(`http://127.0.0.1:${port}`, { timeoutMs: 1_500 })).toBe(false);
  });

  it("rejects when the URL is unreachable (edge not ready yet)", async () => {
    expect(await verifyTunnelServesHost("http://127.0.0.1:9", { timeoutMs: 1_500 })).toBe(false);
  });
});

describe("binary detection overrides", () => {
  it("C2C_<NAME>_PATH wins outright over auto-detection", () => {
    const previous = process.env.C2C_CLOUDFLARED_PATH;
    try {
      process.env.C2C_CLOUDFLARED_PATH = "D:/tools/cloudflared-custom.exe";
      expect(findBinary("cloudflared")).toBe("D:/tools/cloudflared-custom.exe");
    } finally {
      if (previous === undefined) delete process.env.C2C_CLOUDFLARED_PATH;
      else process.env.C2C_CLOUDFLARED_PATH = previous;
    }
  });
});

describe("normalizeNamedTunnelHostname", () => {
  it("normalizes a valid hostname", () => {
    expect(normalizeNamedTunnelHostname("Dev.GetRemi.xyz.")).toBe("dev.getremi.xyz");
  });

  it("rejects URLs and invalid hostnames", () => {
    expect(() => normalizeNamedTunnelHostname("https://dev.getremi.xyz")).toThrow(/invalid/i);
    expect(() => normalizeNamedTunnelHostname("localhost")).toThrow(/invalid/i);
  });
});

describe("named hostname helpers", () => {
  it("builds a stable c2c-<project>.<zone> hostname", () => {
    expect(suggestedNamedHostname("Example.COM", "My App", "abcdef123456")).toBe("c2c-my-app.example.com");
  });

  it("falls back to the workspace id when the name is not ASCII", () => {
    expect(hostnameSlug("回声", "abcdef123456")).toBe("c2c-ws-abcdef12");
  });

  it("parses a typed domain", () => {
    expect(parseZoneInput("https://Example.com/")).toBe("example.com");
    expect(parseZoneInput("not a domain")).toBeNull();
  });
});

describe("cloudflared output parsers", () => {
  it("reads a tunnel list table", () => {
    const output = `
ID                                   NAME          CREATED
11111111-1111-1111-1111-111111111111 c2c-abc123    2026-08-30
`;
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" },
    ]);
  });

  it("reads created-tunnel output", () => {
    expect(
      parseCreatedTunnel(
        "Created tunnel c2c-abc with id 22222222-2222-2222-2222-222222222222",
        "c2c-abc"
      )
    ).toEqual({ id: "22222222-2222-2222-2222-222222222222", name: "c2c-abc" });
  });

  it("treats an existing DNS route as success", () => {
    expect(isBenignRouteError("Failed to add route: record already exists")).toBe(true);
  });
});

describe("tunnel preference state", () => {
  it("asks once, then remembers a quick choice", () => {
    stateDirs.push(isolateStateDir());
    const unset = readTunnelState("ws1");
    expect(needsTunnelChoice(unset)).toBe(true);
    const saved = chooseQuickTunnel("ws1");
    expect(saved.preference).toBe("quick");
    expect(needsTunnelChoice(readTunnelState("ws1"))).toBe(false);
    expect(isNamedTunnelReady(saved)).toBe(false);
  });

  it("provisions a named hostname through the account adapter and stores it outside the project", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("named");
      expect(result.state.hostname).toBe("c2c-demo.example.com");
      expect(result.state.tunnelName).toBe("c2c-abcdef123456");
      expect(isNamedTunnelReady(readTunnelState("abcdef123456"))).toBe(true);
    });
  });

  it("falls back to a temporary address when named provisioning fails", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("no zone");
      },
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(true);
      expect(result.state.preference).toBe("quick");
      expect(result.userMessage).toMatch(/临时地址/);
    });
  });
});
