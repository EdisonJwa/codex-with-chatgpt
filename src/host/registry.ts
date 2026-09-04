import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { PairingManager } from "../pairing/manager.js";
import { pruneExecutionRecords } from "../execution/records.js";
import { pruneAuditEntries } from "../execution/audit.js";
import type { HostWorkspaceRecord } from "./state.js";

/** Everything the host keeps in memory for one registered workspace. */
export interface WorkspaceContext {
  workspace: Workspace;
  authStore: AuthStore;
  pairing: PairingManager;
  registeredAt: string;
}

export interface WorkspaceSummary {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
}

/**
 * In-memory registry of the workspaces this host serves. Registration is
 * idempotent by workspace id (stable hash of the canonical root). Auth
 * stores are persisted per workspace and survive host restarts; pairing
 * sessions are in-memory only.
 */
export class WorkspaceRegistry {
  private contexts = new Map<string, WorkspaceContext>();

  constructor(private readonly opts: { pairingTtlMs?: number } = {}) {}

  /** Idempotent. Loads (or creates) the workspace's persisted auth store. */
  register(workspaceRoot: string, authStoreFile?: string): { context: WorkspaceContext; created: boolean } {
    const workspace = new Workspace(workspaceRoot);
    const existing = this.contexts.get(workspace.id);
    if (existing) return { context: existing, created: false };
    const context: WorkspaceContext = {
      workspace,
      authStore: new AuthStore(workspace.id, { file: authStoreFile }),
      pairing: new PairingManager(workspace.id, { ttlMs: this.opts.pairingTtlMs }),
      registeredAt: new Date().toISOString(),
    };
    this.contexts.set(workspace.id, context);
    // Retention runs on every registration path (host start included):
    // execution records and the audit ledger are bounded state, not archives.
    try {
      pruneExecutionRecords(workspace.id);
      pruneAuditEntries(workspace.id);
    } catch {
      // best effort — a failed prune must never block registration
    }
    return { context, created: true };
  }

  /** Removes only this workspace; auth state stays persisted on disk. */
  unregister(workspaceId: string): boolean {
    return this.contexts.delete(workspaceId);
  }

  get(workspaceId: string): WorkspaceContext | undefined {
    return this.contexts.get(workspaceId);
  }

  list(): WorkspaceContext[] {
    return [...this.contexts.values()];
  }

  findByRoot(workspaceRoot: string): WorkspaceContext | undefined {
    const probe = new Workspace(workspaceRoot);
    return this.contexts.get(probe.id);
  }

  get size(): number {
    return this.contexts.size;
  }

  toRecords(): HostWorkspaceRecord[] {
    return this.list().map((context) => ({
      id: context.workspace.id,
      root: context.workspace.root,
      name: context.workspace.name,
      registeredAt: context.registeredAt,
    }));
  }
}
