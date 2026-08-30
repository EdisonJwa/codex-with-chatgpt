# C2C V2 Design (post-review)

Status: reviewed by ChatGPT (C2C task `c2c_d41e`) — APPROVED WITH REQUIRED
ARCHITECTURAL CORRECTIONS, folded in below. Target branch: `refactor/v2`.
We maintain this fork permanently; upstream compat is dropped; clean state
break accepted (one-time re-pair).

## 1. Shared host, workspace-scoped public routing

- ONE machine-level host process serves all workspaces (registry +
  token dispatch), one machine tunnel, one connector.
- **Per-workspace resource URLs** (required correction — token dispatch
  alone does not bind pre-auth OAuth/DCR/pairing to a workspace):
  - Public shape: `https://<host>/w/<workspaceId>/mcp`
  - Workspace-scoped OAuth routes: `/w/<id>/.well-known/...`,
    `/w/<id>/oauth/{register,authorize,token,revoke}`
  - Bearer tokens validated against BOTH workspaceId and resource path.
  - Multiple connectors get genuinely distinct MCP resources; no
    machine-global token index; no scanning every auth store per request.
  - Plain `/mcp` is at most a legacy migration route, not canonical.
  - Do NOT point multiple connectors at an identical `/mcp` URL unless a
    real acceptance test proves connector-instance token isolation.
- Tokens bound to the expected OAuth `resource`, not only workspaceId.

## 2. Host election & lifecycle

- **Fixed loopback port is the election primitive.** No
  EADDRINUSE→ephemeral fallback, no host.lock: the candidate that binds
  the port wins and atomically writes `host.json`; losers see EADDRINUSE,
  wait briefly, authenticate `/admin/info`, register with the winner.
  Port held by a non-C2C process → fail explicitly.
- `host.json` schema: `schemaVersion, instanceId, pid, port, adminToken,
  startedAt, publicUrl, tunnelMode, tunnelConfigId, workspaces[]`.
  `instanceId` guards stale-state/pid-reuse adoption; discovery trusts
  only authenticated `/admin/info` with matching instanceId (`/health`
  is liveness only).
- Lifecycle: `WorkspaceContext` (Workspace, AuthStore, PairingManager,
  registeredAt); idempotent register; unregister removes only that
  workspace WITHOUT revoking its auth; RUNNING → (last unregister) →
  IDLE_GRACE → DRAINING → CLOSED; registration during grace cancels
  shutdown; after socket close begins, no new registrations (CLI retries
  against the next host).

## 3. Storage (4 layers)

Keep: `auth/<ws>.json` (schema-versioned), `executions/<ws>.jsonl`
(+`tool` field), `tunnel.json` (machine), `host.json`. Drop:
`runtime/<ws>.json`, `endpoints/`, `sessions/`, `tunnels/<ws>.json`,
`runtime/tunnels/*.lock`. Logs are operational, not state.

- Quick-mode connector rebinding: store pairing-generation metadata on
  the OAuth client registration (`resourceUrl`/`resourceUrlHash`,
  `tunnelGeneration`, `pairedAt`) so doctor can tell "quick URL rotated →
  connector recreation required". Named mode needs nothing (stable URL).
- Migration: lazy + idempotent; first V2 startup inspects legacy
  `runtime/*.json`, authenticates and STOPS live V1 bridges, waits for
  their cloudflared children to exit, then starts the V2 connector
  (fail-closed if a legacy bridge refuses to stop) — never two named
  connectors for one hostname. Legacy folders are deleted only after the
  new host/auth/tunnel state validates. State dir name stays
  `codex-with-chatgpt`.

## 4. Security plan

- Admin token: SHA-256 both sides then `timingSafeEqual`; no length branch.
- Scopes: omitted scope → default set; ANY unsupported scope →
  `invalid_scope` (never intersect-then-fallback-to-all).
- OAuth `resource` validated exactly against the workspace route.
- Pairing throttle: no `req.ip` (remove `trust proxy` entirely; public
  base URLs come from host tunnel state, not forwarded headers);
  5-attempt session cap + machine-global bucket.
- Cap dynamic client registrations per workspace (DCR is unauthenticated
  and currently grows auth state unboundedly); pending authorize requests
  hard-capped with 429 on overflow.
- Pairing page: escape workspace/client/error text; `Cache-Control:
  no-store`; CSP `default-src 'none'`.
- Refresh tokens: `familyId` + generation + tombstones; reuse of a
  consumed refresh token revokes the whole family (rotated credentials
  included); prune expired tombstones. Tokens bound to `resource`.
- Sensitive matcher case-insensitive (`.ENV` bypass); `git_status` parsed
  via `--porcelain=v2 -z` and filtered on both rename sides.
- Atomic JSON writes (temp+rename) for host/auth/tunnel state; strict
  reads — corruption/permission errors are explicit, never "absent".
- `/mcp` JSON limit 1 MB (controlled 413); OAuth/urlencoded endpoints get
  smaller independent limits.

## 5. Tunnel

- Single provider lifecycle (discriminated config `{mode:"quick"} |
  {mode:"named", hostname, target, credentialsFile}`), shared
  spawn/scan/timeout/lastError/bounded-stop/windowsHide; the
  SIGTERM→wait→SIGKILL shutdown becomes behavior for both modes.
- `TunnelProvider` shrinks to `start(port) / stop() / status() /
  getPublicUrl()`; provider-level `doctor()`/`restart()` deleted.
- Keep a host-level `POST /admin/tunnel/reload` (stop → re-read machine
  config → construct → start on same port → update host state);
  `/admin/tunnel/stop` removed.
- machine-config: cache keyed by file stat, always re-check credentials
  readability; findBinary caches positive hits only (negative hits short
  TTL).

## 6. Host module shape

`src/host/server.ts` (routes, dispatch, shutdown) · `src/host/manager.ts`
(findLiveHost, ensureHost, election/adoption, unregister client) ·
`src/host/state.ts` (host.json schema, atomic/strict IO) ·
`src/host/registry.ts` (WorkspaceContext, register/unregister/lookup).

## 7. Multi-tool

- `tool` on ExecutionRecord; readers filter:
  `execution_summary({tool?, taskId?, limit?})`, `test_status({tool?})`;
  legacy records report `tool: null`.
- Task IDs: 8-12 random hex (4 hex = 16 bits is collision-prone).
- Optional `TOOL:` header in the control protocol.
- Bridge core tool-agnostic; `SandboxAdapter` interface with
  `CodexConfigSandboxAdapter` behind a registry; `c2c sandbox-allow` stays
  as a compatibility command routed through adapters.

## 8. CLI

Split AFTER the host API is stable: `src/cli/index.ts` (program only) +
`src/cli/{context.ts, http.ts, commands/*.ts}`. Stable JSON error codes
separate from English human strings. One `/admin/info` per stable host
generation (refetch after any reload/restart). Delete `c2c session`,
`c2c workspace`, endpoint helpers, per-workspace tunnel choice, and the
AdminInfo twin only after replacements are exercised by tests.

## 9. SKILL.md

English-only, 443 → ~220-270 lines. Remove: per-workspace tunnel choice,
Cloudflare provisioning/login flow, session URL persistence,
endpoint-reclaim bookkeeping, legacy namedRepair paths, legacy connector
naming. Keep: golden safety rules, one-IAB-tab rule, personalized
Temporary Chat setup, doctor gate, INIT→PLAN→EXECUTED→review loop,
record continuity, HANDOFF, small recovery map. Document: Quick mode may
require connector recreation on new host generation; Named machine mode
never should.

## 10. Implementation order

1. State/security primitives (atomic JSON IO, strict reads, sensitive
   matching, status filtering, strict scopes, HTML hardening, request
   caps, refresh families).
2. Shared-host foundation (election, host.json, registry,
   register/unregister, authenticated discovery, empty-host lifecycle)
   — keep existing tunnel/CLI wrappers temporarily.
3. Workspace-scoped public routing (`/w/<id>/mcp`, workspace OAuth,
   resource-bound tokens, multi-workspace MCP isolation).
4. Machine tunnel cutover (host-owned provider, V1 drain/migration,
   host-level reload).
5. Storage cut (remove legacy state after migration tests pass).
6. Multi-tool + CLI modularization.
7. Skill/protocol/docs (English-only skill, de-branding, security model,
   migration/recovery docs).
8. Dedup/performance/dead-code deletion (legacy modules deleted last).
Do not mix the host cutover with the CLI rewrite in one commit.

## 11. Acceptance tests (required)

- 10 concurrent `c2c start` calls for different workspaces converge on
  one PID/port; two registered workspaces use their connectors
  independently with correct `workspace_info`.
- Token/client for A cannot access B's resource; pairing code for A
  cannot authorize B.
- Stop A leaves B working; last unregister exits the host after grace;
  register during grace cancels shutdown; host crash+restart restores
  registered workspaces; stale/wrong `host.json` fails authenticated
  instanceId adoption.
- Quick URL rotation detected via paired generation; V1 migration never
  leaves old+new named connectors routing simultaneously.
- Unknown/partial scopes → `invalid_scope`; DCR/pending caps resist
  growth; refresh replay revokes the family; `.ENV`/`SECRETS.JSON`/
  sensitive renames never surface via MCP or git_status; 1 MB cap → 413;
  corrupt host/auth/tunnel state is explicit, never default-empty;
  records from two tools stay separable via `tool`.
- Real ChatGPT acceptance: personalized Temporary Chat per session with
  connector, no saved URL (carried over from V1 acceptance).
