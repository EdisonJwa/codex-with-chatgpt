# C2C V2 Design (post-review)

Status: reviewed by ChatGPT (C2C task `c2c_d41e`) — APPROVED WITH REQUIRED
ARCHITECTURAL CORRECTIONS, folded in below. Target branch: `refactor/v2`.
We maintain this fork permanently; upstream compat is dropped; clean state
break accepted (one-time re-pair).

## 1. Shared host, ONE MCP endpoint, multiple agent identities

USER DECISION (overrides the review's per-workspace URL correction):
multiple agents/identities share ONE canonical MCP endpoint.

- ONE machine-level host process serves all workspaces (registry +
  token dispatch), one machine tunnel, one connector.
- Public shape: `https://<host>/mcp` — the single canonical endpoint.
- **Multiple agent identities**: every connecting agent/tool performs its
  own DCR (unique clientId per connector) and its own pairing
  (the pairing code selects the workspace). Tokens are issued per client
  and bound to BOTH the workspaceId AND the canonical `resource` string
  (resource-bound tokens), so credentials from a different deployment are
  rejected and each identity is independently revocable.
- OAuth routes are host-level (`/oauth/{register,authorize,token,revoke}`
  + `/.well-known/...`); the consent page names the workspace the pairing
  code selects; the token exchange carries and validates `resource`.
- Dispatch at `/mcp`: bearer -> authStore lookup (indexed by client
  registry) -> token's workspaceId -> that workspace's MCP handler +
  workspace context. A token whose record's workspaceId differs from its
  owning store is rejected (403).
- Accepted trade-off (documented): connector isolation on the ChatGPT
  side relies on per-connector DCR rather than distinct URLs; the consent
  page + workspace-named pairing codes are the human-side safeguard.
- Workspace registry: `host.json` workspaces[] + per-workspace
  `WorkspaceContext` in the host; register/unregister per workspace.

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

## 3. Storage (5 layers)

Keep: `auth/<ws>.json` (schema-versioned), `executions/<ws>.jsonl`
(+`tool` field), `tunnel.json` (machine), `host.json`, `sessions/<ws>.json`
(session URL — user decision 2026-09-04, see §15). Drop:
`runtime/<ws>.json`, `endpoints/`, `tunnels/<ws>.json`,
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
generation (refetch after any reload/restart). Delete `c2c workspace`,
endpoint helpers, per-workspace tunnel choice, and the AdminInfo twin only
after replacements are exercised by tests. `c2c session` is REINSTATED
(2026-09-04, §15): show/set the workspace's saved ChatGPT conversation URL.

## 9. SKILL.md

Status: DONE (2026-09-04) — 443 → 320 lines, English-only instructions
(user-facing quoted strings stay Chinese by design), zero V1 references:
per-workspace tunnel choice, Cloudflare provisioning/login flow,
endpoint-reclaim bookkeeping, legacy namedRepair/chatgptRepair fields all
removed. Kept: golden safety rules, one-IAB-tab rule, workspace-chat
session flow (§15), doctor gate (V2 report fields incl. capabilities),
INIT→PLAN→EXECUTED→review loop, record continuity, HANDOFF, small recovery
map. Added: `c2c selftest` as the public-path gate after connector repair,
`c2c session` pointer updates, 8-hex task ids, record `--slug`. The two
protocol message templates stay inline in the skill to avoid format
drift — that is why it lands slightly above the original 270 estimate.

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
- Real ChatGPT acceptance: the workspace's persistent chat with connector,
  URL saved via `c2c session set` only after the workspace_info check, and
  a later session resuming the SAME conversation (revised 2026-09-04, §15).

## 12. Relation to steipete/oracle (`askoracle.sh`)

oracle = one-shot CLI/MCP that bundles a prompt with explicitly selected
files and sends them to a model (API or signed-in ChatGPT/Gemini browser),
with sessions, follow-ups, multi-model panels, and a Windows-host/SSH
bridge for browser sessions.

Comparison with C2C:
- Context model: oracle PUSHES selected files into the prompt; C2C lets the
  model PULL workspace data itself via read-only MCP (no pasting, agent-
  driven exploration, live diff/test reads).
- State: oracle keeps per-run sessions; C2C uses one persistent workspace
  chat (saved session URL, §15) plus local execution records for continuity.
- Auth: oracle uses API keys or a signed-in browser session (bridge mode =
  SSH reverse tunnel + bearer token + capability-advertising /health —
  patterns that independently validate our loopback + admin-token design);
  C2C uses OAuth + pairing per agent identity.
- Verdict: complementary, not competing. C2C remains the data plane
  (workspace MCP); oracle can serve as an OPTIONAL second-model reviewer
  inside the review loop (via oracle-mcp or `oracle -p ... --file` in the
  skill's review step) without changing the V2 architecture. Not a
  dependency; revisit if the user wants oracle-based review as default.

## 13. Adopted inspirations from steipete/oracle (post-review additions)

Status: IMPLEMENTED on `refactor/v2` (records retention, audit ledger +
resource, execution-record resource, `/admin/info` capabilities + doctor
drift check, `c2c selftest`, `record --slug`, env-gated live test +
`tests/live/lock.ts`, `docs/windows.md`). Remaining follow-up: consume
capabilities/selftest from the skill (lands with the §9 skill pass).

ADDITIVE ONLY — does not amend the reviewed sections above. Each item
names the oracle pattern it borrows and the implementation step (§10)
where it lands.

1. **Execution record retention/pruning** (oracle `sessionStore.prune`):
   `executions/<ws>.jsonl` is append-only and currently grows forever;
   prune on host start (age or count cap) using the same atomic-write
   discipline as §3. Step 5 (storage cut).
2. **Execution records as MCP resources** (oracle
   `oracle-session://{id}/{metadata|log|request}`): register a
   workspace-scoped resource template such as
   `c2c://execution/{id}/record` alongside `execution_summary`, so
   ChatGPT can pull one full record when a summary is not enough. Same
   sensitive filtering and workspace scoping as tools. Steps 3/6.
3. **Per-identity read audit** (inspired by oracle `--files-report` /
   token stats, mapped to the PULL side): lightweight ledger of which
   agent identity (clientId) read which paths/tools and when, persisted
   with execution records and surfaced via `execution_summary` /
   `c2c logs`. Accountability for the §1 multi-identity endpoint. Step 6.
4. **Env-gated live acceptance tests + serialization lock** (oracle
   `tests/live/*` + `liveLock.ts`): `C2C_LIVE=1` suite drives real
   pairing → tool call → tunnel rotation against real ChatGPT, serialized
   so live runs never overlap. Makes §11 "real ChatGPT acceptance"
   repeatable instead of a one-off ritual. Step 7.
5. **`c2c selftest`** (oracle `--dry-run`): in-process MCP client through
   the REAL public URL with a throwaway token, exercising
   tunnel → OAuth → tool → sanitized output end-to-end; formalizes the
   setup "file read test" as a doctor-verifiable check after tunnel
   reloads or host migration. Steps 2/6 (doctor).
6. **Version/capability advertising on `/admin/info`** (oracle
   capability-advertising `/health`): advertise tool list + schema/skill
   version so the skill's doctor gate detects skill/server drift (the
   skill self-updates daily, so drift is a ROUTINE state) and rebuilds.
   Extends §2 `host.json` / §8 CLI. Step 2.
7. **Optional human-readable slug on ExecutionRecord** (oracle `consult`
   `slug`): alongside the 8-12 hex task IDs of §7, an optional short slug
   for human- and ChatGPT-friendly references in conversation and
   `c2c logs`. Step 6.
8. **Windows platform-quirks doc** (oracle `docs/windows-work.md`): one
   page covering win32 quirks in process lifecycle, tunnels, and file
   locking — the areas V2 touches most and where C2C development
   actually runs. Step 7 (docs).

Explicitly NOT adopted (guardrails):

- `--render`/manual-paste fallback: reintroduces repo upload into a
  prompt — the exact thing C2C exists to prevent.
- Cookie-based browser automation of ChatGPT: C2C stays on the official
  connector + OAuth; cookie scraping is oracle's biggest fragility.
- Full transcripts on disk: oracle stores complete request/response
  logs; C2C's tiny control-plane records are a privacy feature.
- Multi-model panels / TUI / notifier: that is oracle's job as the
  optional external reviewer per §12, not C2C's.

## 14. Upstream sync review (XiaoDuoYa/codex-with-chatgpt, 2026-09-04)

21 upstream commits since the fork (`6395334`..`a9f91cd`). Reviewed for
V2 reuse; disposition:

ADOPTED (implemented):

- Quick-tunnel fail-closed startup (#92): reject cloudflared's
  `api.trycloudflare.com` as a URL; `start()` resolves only after the
  public `/health` identifies `SERVICE_NAME`; `C2C_CLOUDFLARED_PATH`
  env override in `findBinary`. Tests in tunnel.test.ts.
- Structured output schemas (#238 + #322): every MCP tool declares a
  zod `outputSchema` (`MCP_TOOL_OUTPUT_SCHEMAS`) and returns
  `structuredContent`; the SDK rejects schema drift at runtime. #322's
  lesson (validate sources) is built in.
- Auth-page hardening remainder from #26: CSP gains
  `base-uri 'none'; frame-ancestors 'none'` + `X-Frame-Options: DENY`.

ALREADY COVERED IN V2 (no change): `windowsHide` on all spawns (quick,
named, host daemon); https OAuth callback URIs; pairing-page escaping /
no-store / CSP baseline.

NOT PORTED — inputs for the §9 skill pass or a future design round:

- Sanitized command-output feature (#44/#322-era: `execution_output`
  tool, key/token/home-path sanitizer, 64KB caps). Good patterns; but it
  adds a 9th tool and changes the public surface — needs its own review
  against §4 before adoption.
- Upstream's session persistence direction (session URLs, ChatGPT
  Project collections, `waitingFor` checkpoint machine) CONFLICTS with
  the V2 decision: personalized Temporary Chats + local records only
  (§9). Revisit only if Temporary Chat continuity proves insufficient.
- `d6d0dd4` inconclusive-probe fix: V1-era daemon probing; V2's strict
  `findLiveHost` + PortInUseError + register-with-winner covers it.

## 15. User decision: session URL persistence (2026-09-04)

USER DECISION ("use session url") — REVERSES the V2 "Temporary Chats only,
never persist a URL" stance (previously §9; upstream made the same move
with its session/project work, see §14).

- Each workspace keeps ONE persistent ChatGPT conversation. Its URL is
  saved locally as `sessions/<ws>.json` (storage: back to 5 layers, §3)
  and reopened by later Codex sessions — conversation context survives
  restarts, which Temporary Chats could never provide.
- Privacy trade-off, accepted: the workspace chat appears in the ChatGPT
  history of the logged-in account (Temporary Chats did not). The
  read-only/no-upload guarantees are unchanged — repo content still flows
  only through the MCP data plane.
- Guards carried over from upstream practice: save the URL ONLY after the
  workspace_info smoke gate passed in that chat; URL validation accepts
  only `https://chatgpt.com/c/<id>` shapes (never start/settings/plugin
  pages or foreign hosts); `--clear` starts over; execution records remain
  the source of truth for task continuity (HANDOFF), the saved URL is the
  convenience path.
- Implementation: `src/session/state.ts` (lenient read — corrupt file
  means "no session"; atomic write), `c2c session {show,set}` (CLI §8),
  skill rewired to resume-by-default / save-after-verification.
