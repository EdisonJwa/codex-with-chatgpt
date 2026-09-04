import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";
import { readJsonStrict, writeJsonAtomic } from "../config/json-store.js";

export const SUPPORTED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

export const AUTH_SCHEMA_VERSION = 2;

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
  /** Canonical resource this client paired against (V2). */
  resource?: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  workspaceId: string;
  scopes: string[];
  /** Refresh-token family: all credentials minted from one pairing. */
  familyId?: string;
  /** Canonical resource the token is valid for (V2 resource binding). */
  resource?: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

interface PersistedAuthState {
  schemaVersion: 2;
  clients: ClientRegistration[];
  tokens: TokenRecord[];
  /** Consumed refresh tokens, kept for replay detection (family revocation). */
  refreshTombstones?: Array<{ hash: string; familyId?: string; consumedAt: number }>;
  /** Families revoked because a consumed refresh token was replayed. */
  revokedFamilies?: Array<{ familyId: string; revokedAt: number }>;
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" | "family_revoked" };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const TOMBSTONE_TTL_MS = 35 * 24 * 60 * 60 * 1000; // outlive refresh tokens
/** Dynamic client registrations per workspace store (DoS bound). */
const MAX_CLIENTS = 50;

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private tombstones = new Map<string, { familyId?: string; consumedAt: number }>();
  private revokedFamilies = new Set<string>();
  private readonly file: string;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string } = {}
  ) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
    this.load();
  }

  private load(): void {
    const read = readJsonStrict<PersistedAuthState>(this.file);
    if (read.status === "absent") return;
    if (read.status === "error") {
      // Security state that cannot be read must never silently become
      // "no tokens" — fail loudly so the operator can fix or reset it.
      throw new Error(read.error);
    }
    const data = read.data;
    const now = Date.now();
    for (const client of data.clients ?? []) this.clients.set(client.clientId, client);
    for (const family of data.revokedFamilies ?? []) {
      if (now - family.revokedAt < REFRESH_TOKEN_TTL_MS) this.revokedFamilies.add(family.familyId);
    }
    for (const tombstone of data.refreshTombstones ?? []) {
      if (now - tombstone.consumedAt < TOMBSTONE_TTL_MS) {
        this.tombstones.set(tombstone.hash, {
          familyId: tombstone.familyId,
          consumedAt: tombstone.consumedAt,
        });
      }
    }
    for (const token of data.tokens ?? []) {
      const familyRevoked =
        token.familyId !== undefined && this.revokedFamilies.has(token.familyId);
      if (!token.revoked && !familyRevoked && token.expiresAt > now) {
        this.tokens.set(token.hash, token);
      }
    }
  }

  private save(): void {
    const now = Date.now();
    for (const [hash, tombstone] of this.tombstones) {
      if (now - tombstone.consumedAt >= TOMBSTONE_TTL_MS) this.tombstones.delete(hash);
    }
    const state: PersistedAuthState = {
      schemaVersion: AUTH_SCHEMA_VERSION,
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > now),
      refreshTombstones: [...this.tombstones.entries()].map(([hash, t]) => ({
        hash,
        familyId: t.familyId,
        consumedAt: t.consumedAt,
      })),
      revokedFamilies: [...this.revokedFamilies].map((familyId) => ({
        familyId,
        revokedAt: now,
      })),
    };
    writeJsonAtomic(this.file, state);
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: {
    clientName?: string;
    redirectUris: string[];
    resource?: string;
  }): ClientRegistration {
    if (this.clients.size >= MAX_CLIENTS) {
      // Unauthenticated DCR must not grow auth state unboundedly.
      throw new Error("too_many_clients");
    }
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      resource: input.resource,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Materialize a pre-auth DCR client into this workspace's store under its
   * ORIGINAL client id (the id the client already knows from /oauth/register).
   * Idempotent.
   */
  ensureClient(client: ClientRegistration): ClientRegistration {
    const existing = this.clients.get(client.clientId);
    if (existing) return existing;
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
    resource?: string;
    familyId?: string;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const now = Date.now();
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;
    // A family is one pairing lineage; rotation stays inside it.
    const familyId = input.familyId ?? randomBytes(12).toString("base64url");

    const accessToken = newToken("c2c_at");
    this.tokens.set(sha256hex(accessToken), {
      hash: sha256hex(accessToken),
      kind: "access",
      clientId: input.clientId,
      workspaceId,
      scopes: input.scopes,
      familyId,
      resource: input.resource,
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (input.scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      this.tokens.set(sha256hex(refreshToken), {
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        workspaceId,
        scopes: input.scopes,
        familyId,
        resource: input.resource,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes: input.scopes,
    };
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (record.familyId !== undefined && this.revokedFamilies.has(record.familyId)) {
      return { ok: false, reason: "family_revoked" };
    }
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /**
   * Refresh-token rotation with replay detection. Consuming a refresh
   * token tombstones it; presenting a tombstoned token again means the
   * family's credentials leaked — the ENTIRE family (including freshly
   * rotated credentials) is revoked.
   */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    const hash = sha256hex(refreshToken);
    const record = this.tokens.get(hash);

    if (!record) {
      if (this.tombstones.has(hash)) {
        // Replay of an already-consumed refresh token: kill the family.
        const familyId = this.tombstones.get(hash)!.familyId;
        if (familyId) {
          this.revokedFamilies.add(familyId);
          for (const [tokenHash, token] of this.tokens) {
            if (token.familyId === familyId) {
              token.revoked = true;
              this.tokens.delete(tokenHash);
            }
          }
          this.save();
        }
      }
      return { ok: false, reason: "invalid_grant" };
    }
    if (record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (record.familyId !== undefined && this.revokedFamilies.has(record.familyId)) {
      return { ok: false, reason: "invalid_grant" };
    }
    if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };

    // Consume: tombstone (kept for replay detection), then rotate in-family.
    this.tokens.delete(hash);
    this.tombstones.set(hash, {
      familyId: record.familyId,
      consumedAt: Date.now(),
    });
    const tokens = this.issueTokens({
      clientId,
      scopes: record.scopes,
      workspaceId: record.workspaceId,
      resource: record.resource,
      familyId: record.familyId,
    });
    return { ok: true, tokens };
  }

  revokeToken(token: string): boolean {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    record.revoked = true;
    this.tokens.delete(record.hash);
    this.save();
    return true;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    const count = this.tokens.size;
    this.tokens.clear();
    this.authCodes.clear();
    this.save();
    return count;
  }

  tokenCount(): number {
    return this.tokens.size;
  }
}

/**
 * Validate + normalize requested scopes.
 * - omitted/empty -> the full supported set (shown on the consent page)
 * - ANY unsupported scope -> null (caller must return invalid_scope;
 *   silent intersection would hide privileges the client thinks it has,
 *   and falling back to all scopes escalates garbage requests)
 */
export function filterScopes(requested: string | undefined): string[] | null {
  if (!requested || requested.trim() === "") return [...SUPPORTED_SCOPES];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  const granted = asked.filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
  if (granted.length !== asked.length || granted.length === 0) return null;
  return granted;
}
