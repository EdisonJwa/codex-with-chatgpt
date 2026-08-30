import { describe, it, expect, afterAll, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";
import {
  clearMachineTunnelConfig,
  machineTunnelFile,
  parseMachineTunnelConfig,
  readMachineTunnel,
  writeMachineTunnelConfig,
} from "../src/tunnel/machine-config.js";
import { effectiveTunnelState, resolveTunnelProvider } from "../src/tunnel/resolve.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { buildNamedRunArgs, CloudflaredNamedTunnel } from "../src/tunnel/cloudflared-named.js";
import { nullLogger } from "../src/logger/index.js";

describe("machine tunnel config", () => {
  let credsDir: string;
  let credsFile: string;

  const good = () => ({
    mode: "cloudflare-named" as const,
    publicUrl: "https://c2c.example.com",
    tunnelName: "Edison-PC",
    tunnelId: "b42367b0-4892-4dbe-a3c2-279e6de880f4",
    credentialsFile: credsFile,
  });

  beforeAll(() => {
    // Parsing validates the credentials file is a real readable file.
    credsDir = makeTmpDir("machine-creds");
    credsFile = write(credsDir, "edison-pc.json", "{}");
  });

  afterAll(() => {
    clearMachineTunnelConfig();
    cleanup(credsDir);
  });

  it("parses a valid config, preferring the tunnel UUID as run target", () => {
    const resolved = parseMachineTunnelConfig({ version: 1, ...good() });
    expect(resolved).not.toBeNull();
    expect(resolved!.hostname).toBe("c2c.example.com");
    expect(resolved!.target).toBe(good().tunnelId);
    expect(resolved!.publicUrl).toBe("https://c2c.example.com");
  });

  it("falls back to the tunnel name as run target and rejects bad configs", () => {
    const nameOnly = parseMachineTunnelConfig({
      mode: "cloudflare-named",
      publicUrl: "https://c2c.example.com/",
      tunnelName: "my-laptop",
      credentialsFile: credsFile,
    });
    expect(nameOnly!.target).toBe("my-laptop");
    // http, paths, fragments, missing targets, wrong mode, bad creds — all invalid
    expect(
      parseMachineTunnelConfig({ mode: "cloudflare-named", publicUrl: "http://c2c.example.com", tunnelName: "x", credentialsFile: credsFile })
    ).toBeNull();
    expect(
      parseMachineTunnelConfig({ mode: "cloudflare-named", publicUrl: "https://c2c.example.com/a/b", tunnelName: "x", credentialsFile: credsFile })
    ).toBeNull();
    expect(
      parseMachineTunnelConfig({ mode: "cloudflare-named", publicUrl: "https://c2c.example.com/#frag", tunnelName: "x", credentialsFile: credsFile })
    ).toBeNull();
    expect(
      parseMachineTunnelConfig({ mode: "cloudflare-named", publicUrl: "https://c2c.example.com", credentialsFile: credsFile })
    ).toBeNull();
    expect(
      parseMachineTunnelConfig({ mode: "quick", publicUrl: "https://c2c.example.com", tunnelName: "x", credentialsFile: credsFile })
    ).toBeNull();
    // credentials file must really exist and be a regular file
    expect(
      parseMachineTunnelConfig({ mode: "cloudflare-named", publicUrl: "https://c2c.example.com", tunnelName: "x", credentialsFile: credsDir })
    ).toBeNull();
    expect(
      parseMachineTunnelConfig({ mode: "cloudflare-named", publicUrl: "https://c2c.example.com", tunnelName: "x", credentialsFile: path.join(credsDir, "nope.json") })
    ).toBeNull();
  });

  it("absent vs malformed vs ok reads fail closed, never silently quick", () => {
    const stateDir = isolateStateDir();
    try {
      expect(readMachineTunnel().status).toBe("absent");
      write(stateDir, "tunnel.json", "{ truncated");
      const malformed = readMachineTunnel();
      expect(malformed.status).toBe("malformed");
      if (malformed.status === "malformed") {
        expect(malformed.error).toContain(machineTunnelFile());
      }
      writeMachineTunnelConfig(good());
      expect(readMachineTunnel().status).toBe("ok");
      clearMachineTunnelConfig();
      expect(readMachineTunnel().status).toBe("absent");
    } finally {
      cleanup(path.join(stateDir, "runtime", "tunnels"));
    }
  });

  it("an existing but unreadable tunnel.json fails closed (EISDIR is not absent)", () => {
    const stateDir = isolateStateDir();
    try {
      // a DIRECTORY at the config path: readFileSync throws EISDIR
      fs.mkdirSync(path.join(stateDir, "tunnel.json"));
      const read = readMachineTunnel();
      expect(read.status).toBe("malformed");
      if (read.status === "malformed") {
        expect(read.error).toContain("cannot be read");
      }
    } finally {
      cleanup(path.join(stateDir, "tunnel.json"));
    }
  });

  it("resolver precedence: machine > workspace named > quick", () => {
    const stateDir = isolateStateDir();
    try {
      const ws = "ws-precedence";
      // quick when nothing is configured
      expect(effectiveTunnelState(ws).source).toBe("quick");
      // workspace named binding
      writeTunnelState({
        workspaceId: ws,
        preference: "named",
        askedAt: new Date().toISOString(),
        tunnelName: `c2c-${ws}`,
        hostname: "c2c-ws.example.com",
      });
      expect(effectiveTunnelState(ws).source).toBe("workspace");
      // machine override wins
      writeMachineTunnelConfig(good());
      expect(effectiveTunnelState(ws).source).toBe("machine");
      const { provider } = resolveTunnelProvider(ws, nullLogger);
      expect(provider.name).toBe("cloudflare-named");
    } finally {
      clearMachineTunnelConfig();
      cleanup(path.join(stateDir, "tunnels"));
      cleanup(path.join(stateDir, "runtime", "tunnels"));
    }
  });

  it("malformed machine config is a startup error, not a fallback", () => {
    const stateDir = isolateStateDir();
    try {
      write(stateDir, "tunnel.json", "{ truncated");
      const effective = effectiveTunnelState("ws-any");
      expect(effective.source).toBe("machine");
      expect(effective.error).toBeTruthy();
      expect(() => resolveTunnelProvider("ws-any", nullLogger)).toThrow(/tunnel\.json/);
    } finally {
      cleanup(path.join(stateDir, "runtime", "tunnels"));
    }
  });

  it("a workspace bridge resolves the machine provider without any patch", async () => {
    const stateDir = isolateStateDir();
    const root = makeTmpDir("machine-ws");
    write(root, "hello.txt", "hello\n");
    writeMachineTunnelConfig(good());
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    try {
      const auth = { authorization: `Bearer ${bridge.adminToken}` };
      const info = (await (
        await fetch(`${bridge.localBaseUrl()}/admin/info`, { headers: auth })
      ).json()) as { tunnel: { provider: string } };
      expect(info.tunnel.provider).toBe("cloudflare-named");
    } finally {
      await bridge.close();
      cleanup(root);
      clearMachineTunnelConfig();
    }
  });
});

describe("generalized named provider", () => {
  it("builds cloudflared argv with the UUID target and credentials file", () => {
    const args = buildNamedRunArgs({
      target: "b42367b0-4892-4dbe-a3c2-279e6de880f4",
      localPort: 48765,
      credentialsFile: "C:/fake/edison-pc.json",
    });
    expect(args).toContain("--credentials-file");
    expect(args.indexOf("--credentials-file")).toBeLessThan(args.indexOf("run"));
    expect(args[args.indexOf("--credentials-file") + 1]).toBe("C:/fake/edison-pc.json");
    expect(args[args.length - 1]).toBe("b42367b0-4892-4dbe-a3c2-279e6de880f4");
  });

  it("reports a missing credentials file before claiming or spawning", async () => {
    const creds = makeTmpDir("missing-creds");
    const provider = new CloudflaredNamedTunnel({
      hostname: "c2c-test.example.com",
      tunnelId: "b42367b0-4892-4dbe-a3c2-279e6de880f4",
      credentialsFile: path.join(creds, "nope.json"),
      logger: nullLogger,
      binaryOverride: process.execPath,
    });
    await expect(provider.start(48765)).rejects.toThrow(/credentials file not found/i);
    cleanup(creds);
  });

  it("workspace named state is ready with a tunnel UUID alone", () => {
    writeTunnelState({
      workspaceId: "ws-uuid-only",
      preference: "named",
      askedAt: new Date().toISOString(),
      tunnelId: "b42367b0-4892-4dbe-a3c2-279e6de880f4",
      hostname: "c2c-ws.example.com",
    });
    const { source, provider } = resolveTunnelProvider("ws-uuid-only", nullLogger);
    expect(source).toBe("workspace");
    expect(provider.name).toBe("cloudflare-named");
    clearMachineTunnelConfig();
  });
});
