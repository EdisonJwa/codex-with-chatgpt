---
name: codex-with-chatgpt
description: >
  Use ChatGPT (web) as the planning and review brain for Codex coding sessions,
  while Codex keeps full execution ownership. Use when the user says
  "使用 Codex with ChatGPT ..." / "Set up Codex with ChatGPT" / "用 ChatGPT 规划",
  when they ask to connect ChatGPT to the current workspace, disconnect it,
  or run a task through the ChatGPT planning loop.
---

# Codex with ChatGPT

ChatGPT thinks. Codex works.

You (Codex) own execution: editing, shell, git, tests, recovery.
ChatGPT owns high-level reasoning: understanding, planning, review, debug strategy.
The C2C host gives ChatGPT read-only MCP access to the current workspace, so
control messages between you and ChatGPT stay tiny (< 1 KB) — ChatGPT pulls
whatever data it needs by itself.

**Golden rules**

1. NEVER paste file contents, diffs, or logs into ChatGPT. ChatGPT reads them through MCP.
2. NEVER show the user technical internals (MCP, OAuth, tunnel, ports, localhost).
   Speak in terms of "连接 ChatGPT / 安全连接 / 配对".
3. The pairing code is the ONLY credential you may ever type into a browser.
   Never touch OAuth tokens, cookies, or session storage.
4. If something fails, run `c2c doctor` and repair silently. Only involve the user
   for logins, CAPTCHA, 2FA, or explicit consent screens — and then give them ONE action.
5. ALWAYS use the built-in in-app browser (iab) for every ChatGPT step (see
   **In-app browser (ChatGPT)**). NEVER Computer Use, never a third-party
   browser, never `open <url>`. Only exception: the user explicitly demands
   their own browser for the one-time Cloudflare login (fixed-address setup).
6. Each workspace has exactly ONE persistent ChatGPT conversation and ONE
   connector. The conversation URL is saved locally and REUSED across Codex
   sessions (`c2c session show/set` — see **The workspace chat**). Never
   create a second connector for the same workspace; never touch another
   workspace's connector or chat.
7. After first-time setup, never ask the user to approve writing C2C's local
   settings directory. Run `c2c sandbox-allow --json` (idempotent). If it fails
   with EPERM, request elevated permissions and retry ONCE, silently.
8. ChatGPT pages: only the URLs listed in **In-app browser (ChatGPT)**. Never
   start from chatgpt.com and click through menus.
9. **Doctor gate.** After `c2c doctor -w <ws> --json`, do not open ChatGPT and
   do not send `[C2C]` until local is green. Not green means any of:
   `report.bridge.ok`, `report.mcp.ok` (unauthenticated `/mcp` must return 401),
   `report.capabilities.ok` (host older than this CLI → `c2c restart -w <ws>`),
   `report.tunnel.ok` (secure connection down), or sandbox/state-dir write
   failures. A ChatGPT-side 401 after a sent message is different: repair then.

## In-app browser (ChatGPT)

Official skill: `control-in-app-browser`. These C2C rules override defaults
that close the tab, hide the window, or stall on the settings page.

1. **Surface.** Once per Codex session: `setupBrowserRuntime()`, then
   `const iab = await agent.browsers.get("iab")`. Reuse `iab`. Never
   `getDefault()` or `getForUrl()`.
2. **One tab.** Create the ChatGPT tab once (`tabs.new()`); afterwards only
   `tab.goto(...)` to switch URLs. Claim the existing tab — never open a
   second ChatGPT tab, never `goto` the URL you are already on.
3. **Foreground + keep (standby).** After opening or claiming the tab:
   `await (await iab.capabilities.get("visibility")).set(true)`, then
   `await tab.markHandoff()` now and at the start/end of every turn. After
   setup succeeds or the workspace chat is open, also
   `await tab.markDeliverable()`. Never close this tab; never let default
   turn cleanup close it.
4. **URLs only** (same tab, `goto` — never hunt menus):
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
   - 插件总管: `https://chatgpt.com/plugins`
   - 加插件: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - This workspace's chat: the saved URL from `c2c session show -w <ws> --json`;
     a fresh chat is `https://chatgpt.com/` (save it once verified, see §7).
   Never click Reconnect / Refresh on an existing connector — the old address
   is dead and that page hangs. When the address changed: Delete THIS
   workspace's `connectorName` only, then create it again via the 加插件 URL.
5. **Do not wait for 8 tools** on the settings page. "Connected" / pairing
   accepted is enough; confirm tools in the chat with `workspace_info`.
6. **Batch.** Fill a known form in one Playwright / `js` script when you can.
   After an action, one cheap DOM check. Do not screenshot-poll. Chat
   composer: fill the text, then click the 发送提示词 button — Enter does NOT
   submit in the in-app browser.
7. **One conversation.** The workspace chat is THE C2C conversation: boot
   prompt + workspace_info check there; once the check passed, save the URL
   (`c2c session set -w <ws> --url <url>`). No throwaway verify chats.
8. **Wait for a ChatGPT reply without one long browser wait.** After sending
   INIT, EXECUTED, the boot prompt, or the workspace_info check:
   `markHandoff`, keep the tab foreground, and every 20–30 seconds one cheap
   state check — a TARGETED locator read (the 停止 button while generating,
   or the last reply's text), never a full page snapshot, which is expensive
   on long conversations. Still generating → wait; `STATE: PLAN` / `DONE` /
   `BLOCKED` / the workspace name → read and continue; visible error →
   repair, do not start a new chat. A browser/js timeout is not failure;
   never open a second tab, never resend INIT/EXECUTED because a wait timed
   out.

## Locations

- The codex-with-chatgpt checkout lives at: `~/codex-with-chatgpt`
  (fix this line to the actual checkout path at install time).
- CLI: `node <checkout>/bin/c2c.js <command>` (or `c2c <command>` if globally
  linked). All commands support `--json` for parsing.
- If the checkout has no `node_modules` or no `dist/`, run
  `corepack pnpm install && corepack pnpm build` inside it first.
- Always pass `-w <workspace root>` (the user's project, NOT the c2c repo).

## Daily update check

At the START of every workflow below, run (cheap, cached; never mention
unless an update exists):

1. `c2c update-check --json`
2. `c2c sandbox-allow --json` — no-op when already allowlisted.

- `{ "updateAvailable": false }` → continue silently.
- `{ "updateAvailable": true }` → tell the user one line:
  "检测到 Codex with ChatGPT 有新版本，我先更新一下（约 1 分钟），随后继续你的任务。"
  Run the update workflow, then CONTINUE the original task.

## Workflow: update

Inside the checkout directory:

1. `git pull --ff-only` (if local edits block it: `git stash && git pull --ff-only`).
2. `corepack pnpm install && corepack pnpm build`.
3. Re-install the Skill: copy `skill/SKILL.md` to
   `~/.codex/skills/codex-with-chatgpt/SKILL.md`, then fix the
   "checkout lives at:" line in the copy.
4. `c2c sandbox-allow --json`, then `c2c restart -w <ws>` so the host runs the
   new code, then `c2c update-check --force --json` (should be up to date).
5. Tell the user "✓ 已更新到最新版本", then resume the triggering task.
   (The updated SKILL.md takes effect next Codex session.)

## Connection (fixed address vs temporary)

The public address is a temporary URL by default and changes on restart; the
connector is repaired automatically after that (see **reconnect**).

1. `c2c tunnel status -w <ws> --json`. If `effectiveSource` is `machine`,
   a machine-wide fixed address is in charge — never ask, never change it.
2. Otherwise stay on the temporary address. Only if the USER asks for a
   stable domain: that is a one-time manual setup — they create a Cloudflare
   tunnel for their domain (their browser, Cloudflare login — Golden rule 5
   exception), then `c2c tunnel set --public-url ... --credentials-file ...`
   (see `c2c tunnel set --help`) and `c2c restart -w <ws>`.
3. Connection credentials always live in the C2C state directory, never in
   the project.

## Workflow: first-time setup

1. Detect prerequisites yourself: `node --version` (>= 20), `cloudflared`
   (macOS: `brew install cloudflared`; Windows: `winget install
   Cloudflare.cloudflared`). Install missing pieces yourself.
2. If the checkout has no `node_modules`/`dist/`: `corepack pnpm install && corepack pnpm build`.
3. `c2c sandbox-allow --json`, then **Connection**, then `c2c setup -w <ws> --json`
   → `{ mcpUrl, pairingCode, workspaceName, connectorName }`. Pairing codes
   expire in ~5 minutes: `c2c pair --json` for a fresh one if you are slow.
4. Open the ONE iab tab (foreground + markHandoff). Settings URLs only:
   - Enable 开发人员模式 if it is off (`#settings/Security`).
   - If `connectorName` already exists on `https://chatgpt.com/plugins`:
     Delete it (never Reconnect), then re-create via the 加插件 URL.
   - Create the connector with that exact `connectorName`: description
     `Securely connect ChatGPT to the current Codex workspace for planning and review.`,
     Server URL = `mcpUrl`, Authentication = OAuth. Fill the form in one
     script. Connect / Authorize / type the pairing code; continue as soon
     as it shows Connected — do not wait for tools on the settings page.
5. Open the workspace chat (fresh: `https://chatgpt.com/`): boot prompt from
   `docs/protocol.md` §Boot Prompt, then the smoke gate:
   `Use the "<connectorName>" connector: call workspace_info and read hello-style top-level file. Reply with the workspace name.`
   Wait per **In-app browser** §8; the reply must match `workspaceName`.
   Then save: `c2c session set -w <ws> --url <this chat's URL> --connector-name "<connectorName>"`.
6. Report exactly (no internals):

```
Codex with ChatGPT

✓ 当前项目已识别
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

If a login wall appears (ChatGPT, Cloudflare): stop, give the user the ONE
action ("请登录 ChatGPT，完成后告诉我'好了'"), then continue.

## The workspace chat (persistent conversation, saved session URL)

Each workspace keeps ONE persistent ChatGPT conversation; its URL is stored
locally and reopened by later sessions, so conversation context survives
restarts. The chat appears in the account's ChatGPT history. Local execution
records remain the source of truth for task state; the saved URL is the
convenience path.

- **Resume (default)**: `c2c session show -w <ws> --json` → `goto` the saved
  URL and continue; no boot prompt mid-conversation — send the next `[C2C]`
  message (one-line refresher if the task is not obvious from the chat).
- **New chat** (first time, or the saved one is gone/stuck): `goto`
  `https://chatgpt.com/`, boot prompt, then the smoke gate (workspace_info
  must reply with the workspace name). Only then
  `c2c session set -w <ws> --url <url>`. Never save an unverified chat; if
  the connector is unavailable in a chat, do NOT send C2C messages — repair.
- **Chat lost / deleted / wrong workspace reply**: new chat, overwrite the
  URL, rebuild with HANDOFF (below).
- **Keep the pointer current**: at state transitions also run
  `c2c session set -w <ws> --task <id> --iteration <n> --state <state>`.
- **HANDOFF** — only for a NON-terminal task in a replacement chat:
  reconstruct the brief from records (`execution_summary` with
  `{"limit": 50}`, filtered to the current `taskId` — the default 5 can lose
  the original INIT goal), send boot prompt + HANDOFF (goal, progress,
  state, known issues, next expected step). A brand-new task needs only
  Boot Prompt + INIT.

## Workflow: coding task

Protocol states: INIT → PLAN → EXECUTING → EXECUTED → REVIEW → (PLAN | DONE | BLOCKED).
All control messages start with `[C2C]`; keep Codex→ChatGPT messages under
1 KB. ChatGPT's replies are substantive (step 3). Docs: `docs/protocol.md`.

0. Daily update check. Then **Connection** check + `c2c doctor -w <ws>
   --json` (auto-repairs). Doctor gate green or you stop. Generate the task
   id: `c2c_` + 8 random hex chars. Record the start:
   `c2c record -w <ws> --task <id> --iteration 0 --state INIT --goal "<goal>"`.
1. Open the workspace chat (resume; new chat only per the rules above).
   Foreground + markHandoff. Do not use the browser to re-read code MCP
   already provides. After sending a control message, wait per §8.
2. Send INIT:

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a2b3c
ITERATION: 0

GOAL:
<user's goal, one paragraph>

INSTRUCTION:
Inspect the connected workspace through the Codex with ChatGPT MCP connector.
Produce a C2C PLAN message.
```

3. Wait for `STATE: PLAN`. Read GOAL/ACTIONS/TESTS/SUCCESS_CRITERIA. A good
   PLAN also carries RATIONALE and concrete per-file edit suggestions; if it
   is a bare one-liner, ask once: "Please expand the plan with rationale and
   concrete per-file suggestions."
4. Execute the plan yourself (your tools, your judgment; ChatGPT does not
   micro-manage tool calls).
5. Record every meaningful transition so ChatGPT can read it via MCP:
   `c2c record -w <ws> --task <id> --iteration 1 --changed-files "src/a.ts,src/b.ts" --tests "27 passed" --exit-status ok --state EXECUTED --summary "implemented X" --next-step "independent diff review"`
   (optional `--slug "<short-label>"` for human-friendly references), plus
   the session pointer (see **The workspace chat**).
6. Send EXECUTED (no diffs, no logs):

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a2b3c
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
```

7. ChatGPT reviews via MCP (git_diff, read_file, test_status) and replies
   DONE / PLAN (next iteration) / BLOCKED.
8. Loop. Respect maxIterations (`.c2c.json`, default 12); at the limit ask:
   "已完成 12 轮协作，仍有未解决问题，是否继续？"
9. DONE → summarize in plain language. BLOCKED → read ChatGPT's reason, fix
   what you can, or surface the ONE decision the user must make.

## Workflow: reconnect (address changed / connector broken)

Normal case after the machine or the temporary address restarted: doctor
already started a new address; the ChatGPT connector still points at the old
one and must be Deleted + re-created (never Reconnect/Refresh/Edit).

1. `c2c doctor -w <ws> --json` until `report.tunnel.ok` is true (its
   `repairs[]` shows what it fixed). Then `c2c setup -w <ws> --json` for a
   fresh `mcpUrl` + `pairingCode` (or `c2c start --json` + `c2c pair --json`).
2. Tell the user one line that you are refreshing the connection; do the
   repair yourself on the iab tab: 开发人员模式 if needed, Delete THIS
   workspace's `connectorName` on 插件总管, then re-create the SAME name via
   加插件 (description / Server URL = new `mcpUrl` / OAuth), Connect +
   pairing code. Continue as soon as it shows Connected.
3. Verify the public path end-to-end: `c2c selftest -w <ws> --json` — every
   step ok, or repair again (this proves tunnel → OAuth → MCP reads work
   before you involve ChatGPT).
4. `c2c doctor --json` green again → reopen the workspace chat by its saved
   URL and continue; the conversation itself survived the address change.
5. If the chat was lost mid-task: **The workspace chat** → HANDOFF.

## Workflow: repair (anything looks broken)

1. `c2c doctor -w <ws> --json`. Doctor gate: no ChatGPT, no `[C2C]` until green.
2. Apply the recovery map. Involve the user only for login / 2FA / CAPTCHA —
   one action.

## Recovery map

| Symptom | Action |
| --- | --- |
| Host not running | `c2c start -w <ws>` (doctor does this automatically) |
| Tunnel down / URL unreachable | `c2c doctor` until `report.tunnel.ok`; machine mode never needs the connector recreated, temporary mode does (see **reconnect**) |
| ChatGPT says tool call failed / 401 | token expired/revoked → re-pair (`c2c pair --json` + authorize) |
| Pairing code rejected/expired | `c2c pair --json` for a fresh code |
| Host older than CLI (`report.capabilities.ok` false) | `c2c restart -w <ws>`; if other workspaces are hosted, tell the user which workspaces to stop first |
| Every new chat "repairs" / cannot write settings | `c2c sandbox-allow --json` (once), silently |
| cloudflared missing | install it yourself (brew/winget), then retry; custom location: set `C2C_CLOUDFLARED_PATH` |
| Start fails: fixed address served by another workspace | Never kill it — tell the user which workspace holds it and ask whether to move it (`c2c stop` there, then start here) |

## Workflow: disconnect

1. `c2c unpair -w <ws>` (revokes all tokens immediately).
2. Optionally remove the connector on the iab tab (`https://chatgpt.com/plugins`);
   only this workspace's `connectorName`. Then `c2c session set -w <ws> --clear`.
3. Tell the user: "已断开 ChatGPT 对该项目的访问。"
