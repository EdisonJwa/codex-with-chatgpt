import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { startHost, PortInUseError, type Host } from "../src/host/server.js";
import { makeTmpDir, cleanup, write, isolateStateDir, nullTunnel, testPort, startTestHost } from "./helpers.js";

/**
 * V2 election model: the fixed port IS the lock. Unlike V1 there is no
 * ephemeral fallback — a second host on the same port must fail loudly
 * (PortInUseError) so `c2c serve` can register with the winner instead.
 */
describe("host election and workspace registry", () => {
  const hosts: Host[] = [];
  let stateDir = "";

  afterAll(async () => {
    for (const host of hosts) await host.close().catch(() => undefined);
    if (stateDir) cleanup(stateDir);
  });

  function makeWorkspace(name: string): string {
    const root = makeTmpDir(name);
    write(root, `${name}.txt`, "hello\n");
    return root;
  }

  it("a second host on the same port loses the election with PortInUseError", async () => {
    stateDir = isolateStateDir();
    const first = await startTestHost({ workspaceRoot: makeWorkspace("election-a") });
    hosts.push(first);
    expect(first.port).toBeGreaterThan(0);

    await expect(
      startHost({
        workspaceRoot: makeWorkspace("election-b"),
        port: first.port,
        persist: false,
        tunnelProvider: nullTunnel,
      })
    ).rejects.toBeInstanceOf(PortInUseError);
  });

  it("registration is idempotent by workspace id; unregister removes only that workspace", async () => {
    stateDir = stateDir || isolateStateDir();
    const root = makeWorkspace("registry-a");
    const host = await startTestHost({ workspaceRoot: root });
    hosts.push(host);

    const first = host.registerWorkspace(root);
    const again = host.registerWorkspace(root);
    expect(again.workspaceId).toBe(first.workspaceId);
    expect(host.registry.size).toBe(1);

    const other = makeWorkspace("registry-b");
    const second = host.registerWorkspace(other);
    expect(host.registry.size).toBe(2);

    expect(host.unregisterWorkspace(first.workspaceId)).toBe(true);
    expect(host.unregisterWorkspace(first.workspaceId)).toBe(false);
    expect(host.registry.size).toBe(1);
    expect(host.registry.get(second.workspaceId)).toBeDefined();
  });
});
