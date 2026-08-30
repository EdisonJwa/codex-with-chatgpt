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
The C2C Bridge gives ChatGPT read-only MCP access to the current workspace, so
control messages between you and ChatGPT stay tiny (< 1 KB) — ChatGPT pulls
whatever data it needs by itself.

**Golden rules**

1. NEVER paste file contents, diffs, or logs into ChatGPT. ChatGPT reads them through MCP.
2. NEVER show the user technical internals (MCP, OAuth, PKCE, tunnel, ports, localhost).
   Speak in terms of "连接 ChatGPT / 安全连接 / 配对".
3. The pairing code is the ONLY credential you may ever type into a browser.
   Never touch OAuth tokens, cookies, or session storage.
4. If something fails, run `c2c doctor` and repair silently. Only involve the user
   for logins, CAPTCHA, 2FA, or explicit consent screens — and then give them ONE action.
5. ALWAYS use the built-in in-app browser (iab) for every ChatGPT step.
   Follow **In-app browser (ChatGPT)** below. NEVER Computer Use (no
   screenshot-click). NEVER launch or control a third-party/external browser
   (Chrome, Safari, Edge…), and never use `open <url>` to hand off to one.
   - The ONLY exception: the user explicitly says the Cloudflare login must use
     their own browser session — that single Cloudflare login step may go through
     their browser; everything else stays in the built-in browser.
   - If the user asks to run ChatGPT in their own browser, refuse politely and
     explain: "Codex 需要持续调用 ChatGPT 和配置连接，这会频繁操作页面，可能影响
     你浏览器的正常使用。ChatGPT 只能跑在内置浏览器里。" Only if the user replies
     with an explicit "我愿意承担影响" may you proceed in their browser; otherwise
     keep ChatGPT in the built-in browser, every time they ask.
6. Use ONE **personalized Temporary Chat per Codex session** for all C2C work
   (see Temporary chats). Never persist a conversation URL, and never run
   `c2c session set`. Each workspace also has exactly ONE ChatGPT connector.
   Do not create a second connector for the same workspace. Other workspaces
   may have their own connectors — never edit those.
7. After first-time setup, never ask the user to approve writing C2C's local
   settings directory. Run `c2c sandbox-allow --json` (idempotent). If it fails
   with EPERM / Operation not permitted, request elevated permissions and retry
   ONCE. After `{ "alreadyAllowed": true }` or `{ "added": true }`, stay silent.
8. ChatGPT pages: only the URLs in **In-app browser (ChatGPT)**. Never start
   from chatgpt.com and click through menus.
9. **Doctor gate.** After `c2c doctor --json`, do not `goto` ChatGPT and do not
   send `[C2C]` until local is green — except the reconnect settings pages when
   `chatgptRepair.needed` is true. Not green:
   - `report.bridge.ok` is not true
   - `report.mcp.ok` is not true (unauthenticated local `/mcp` must be 401)
   - sandbox / state-dir write failed (EPERM)
   - this workspace used to have a public URL and the tunnel is down
   - `chatgptRepair.needed` is true (fix the connector first, then doctor again)
   - `namedRepair.needed` is true (user must login to Cloudflare, then doctor again.
     Do not Delete the ChatGPT connector — the address did not change)
   A ChatGPT-side 401 after a sent message is different: repair then, do not
   treat it as permission to skip this gate next time.

## In-app browser (ChatGPT)

Official skill: `control-in-app-browser`. These C2C rules override defaults
that close the tab, hide the window, or stall on the settings page.

1. **Surface.** Once per Codex session: `setupBrowserRuntime()`, then
   `const iab = await agent.browsers.get("iab")`. Reuse `iab`. Do not re-read
   `documentation()` if it is already bound. Never `getDefault()`, `getForUrl()`,
   or Computer Use.

2. **One tab.** Create the ChatGPT tab once (`tabs.new()`). After that, only
   `tab.goto(...)` to switch URLs. If the tab still exists, claim it — never
   open a second ChatGPT tab. Do not `goto` the URL you are already on.

3. **Foreground + keep (standby).** Right after opening or claiming the tab:
   - `await (await iab.capabilities.get("visibility")).set(true)` — first-time
     setup and ChatGPT chatting stay in front of the user so they can watch.
   - `await tab.markHandoff()` immediately, then again at the start and end of
     every turn. After setup succeeds or the C2C chat is open, also
     `await tab.markDeliverable()`.
   Never close this tab. Finished, waiting for the user, or timed out: leave it
   marked (standby). Do not let default turn cleanup close it.

4. **URLs only** (same tab, `goto` — never hunt menus):
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
   - 插件总管: `https://chatgpt.com/plugins`
   - 加插件: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - Temporary Chat (one per Codex session): `https://chatgpt.com/?temporary-chat=true`
   - Existing temp chat of this session: keep using its current URL; never
     re-goto it, never save it
   Never click Reconnect / Refresh on an existing connector. The old address is
   dead and that page hangs on "This site cannot be reached". When the address
   changed: Delete THIS workspace's `connectorName` only, then create it again
   via the 加插件 URL (same name, new Server URL).

5. **Do not wait for 8 tools** on the settings page. "Connected" / authorize
   success / pairing accepted is enough. Confirm tools in the conversation with
   `workspace_info`.

6. **Batch.** Fill a known form in one Playwright / `js` script when you can.
   After an action, one cheap DOM check. Do not screenshot-poll.

7. **One conversation.** The first ChatGPT chat is the C2C conversation. Send
   the boot prompt and the workspace_info check there. NEVER save or persist
   that URL (Temporary Chat policy, Golden rule 6). Do not open a throwaway
   verify chat and later another C2C chat.

8. **Wait for a ChatGPT reply (do not hold one long browser wait).** After you
   send INIT, EXECUTED, boot, or the workspace_info check: `markHandoff`, keep
   the tab foreground, and stay in this same task. Do not `waitFor` 5 minutes
   and do not screenshot-poll. Every 20–30 seconds, one cheap DOM check:
   - still generating → wait again (do not type, do not resend);
   - `STATE: PLAN` / `DONE` / `BLOCKED` / the verify workspace name → read it
     and continue the existing protocol;
   - visible error → repair; do not start a new chat.
   A browser/js timeout is not failure. Claim the same tab, read the page, keep
   standby. If ChatGPT is still thinking, keep polling. Never open a second
   tab and never resend INIT/EXECUTED just because a wait timed out.

## Locations

- The codex-with-chatgpt checkout lives at: `/Users/xiaoduo_/Codex_With_ChatGPT`
- CLI: run `node /Users/xiaoduo_/Codex_With_ChatGPT/bin/c2c.js <command>`
  (or `c2c <command>` if globally linked). All commands support `--json` for parsing.
- If the checkout has no `node_modules` or no `dist/`, first run
  `corepack pnpm install && corepack pnpm build` inside it.
- Always pass `-w <workspace root>` (the project the user is working on, NOT the c2c repo).

## Daily update check

At the START of every workflow below (before anything else), run these two
commands (both are cheap / cached; never mention them unless an update exists):

1. `c2c update-check --json`
2. `c2c sandbox-allow --json` — writes the C2C state directory into Codex's
   sandbox `writable_roots` (macOS: `~/Library/Application Support/codex-with-chatgpt`;
   Windows: `%LOCALAPPDATA%\codex-with-chatgpt`; config file is
   `~/.codex/config.toml` on both, or `%USERPROFILE%\.codex\config.toml` on Windows).
   If already allowlisted, this is a no-op and does not trigger elevation.

- `{ "updateAvailable": false }` → continue silently. Never mention the check.
- `{ "updateAvailable": true }` → tell the user one line:
  "检测到 Codex with ChatGPT 有新版本，我先更新一下（约 1 分钟），随后继续你的任务。"
  Then run the update workflow below, and CONTINUE the original task afterwards.

## Workflow: update（"更新 Codex with ChatGPT"，or triggered by the daily check）

Inside the checkout directory (see Locations):

1. `git pull --ff-only` (if it fails due to local edits: `git stash && git pull --ff-only`).
2. `corepack pnpm install && corepack pnpm build`.
3. Re-install the Skill: copy `skill/SKILL.md` to
   `~/.codex/skills/codex-with-chatgpt/SKILL.md`, then fix the "checkout lives at:"
   line in the copy to the actual checkout path.
4. `c2c sandbox-allow --json` (so existing installs pick up the sandbox allowlist),
   then `c2c restart -w <workspace>` so the bridge runs the new code, then
   `c2c update-check --force --json` to refresh the cache (should now report up to date).
5. Tell the user "✓ 已更新到最新版本" — then resume whatever task triggered this.
   (The updated SKILL.md takes effect from the next Codex session; that's expected.)

## Connection choice (once per workspace)

Ask this **before** the public address exists (`c2c setup` / first `doctor --fix`
that starts a tunnel). Do not mention tunnels, wrangler, DNS, or hostnames.
Speak only of 临时地址 / 固定域名 / 登录 Cloudflare.

1. `c2c tunnel status -w <workspace> --json`
2. If `needsChoice` is false: do not ask again. If `effectiveSource` is
   `machine`, a machine-wide fixed address (tunnel.json, managed with
   `c2c tunnel machine-status / machine-set / machine-unset`) overrides the
   per-workspace choice — treat it as 固定域名 and never ask.
3. If `needsChoice` is true: tell the user exactly `userPrompt` and wait.
   - 没有账号 / 没有域名 / 临时 / 不用 →
     `c2c tunnel choose -w <ws> --mode quick --json`
   - 有域名（例如 example.com）→ first tell them `loginPrompt`, then
     `c2c tunnel choose -w <ws> --mode named --zone <domain> --json`.
     This may open the user's own browser (the Cloudflare exception in
     Golden rule 5). Wait until the command finishes.
     If they said they have an account but gave no domain: ask once for the
     domain. If the command returns `need: "zone"`, ask once and retry.
     If `fallback` is true: tell them `userMessage` and continue on the
     temporary address. Do not retry named unless they ask.
4. Never put connection credentials in the project. The CLI stores them in
   the C2C state directory.

## Workflow: first-time setup（"使用 Codex with ChatGPT 完成首次配置"）

1. Detect prerequisites yourself: `node --version` (>= 20), and check `cloudflared`.
   - If cloudflared is missing on macOS run `brew install cloudflared`; on Windows use
     `winget install Cloudflare.cloudflared`. Do this yourself; don't ask.
2. If the c2c repo has no `node_modules`, run `pnpm install && pnpm build` in it.
3. Run `c2c sandbox-allow --json`, then **Connection choice**, then
   `c2c setup -w <workspace> --json`.
   `sandbox-allow` edits Codex `config.toml` only — it adds C2C's state directory
   to `[sandbox_workspace_write].writable_roots` so later chats can write logs
   without elevation. If the write is denied, request approval and retry once.
   → returns `{ mcpUrl, pairingCode, workspaceName, connectorName, ... }`.
   `connectorName` is this workspace's plugin title (legacy installs stay
   `Codex with ChatGPT`; additional workspaces get `Codex with ChatGPT · <name>`).
   Pairing codes expire in ~5 minutes: run `c2c pair --json` for a fresh one if you're slow.
4. Open ChatGPT on the ONE iab tab (see **In-app browser**). Foreground +
   markHandoff immediately. Same tab, `goto` only:
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
     Enable 开发人员模式 ("Developer mode") if it is off.
   - 已有该 `connectorName`: `https://chatgpt.com/plugins` — Delete it (never
     Reconnect). Then `goto` the 加插件 URL below.
   - 还没有 / 刚删掉: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
     Operate ONLY on `connectorName` from step 3:
      - If that exact name exists: Delete it, then create it again. Never
        Reconnect, never edit-in-place, never open the old Server URL.
      - If it does not exist: create one with that exact name.
      - Never rename, delete, or edit a connector that belongs to another workspace.
      - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
      - Server URL: the `mcpUrl` from step 3
      - Authentication: OAuth
     Fill the known form in one script when you can. Then Connect / Authorize
     and type the pairing code. As soon as it shows Connected / authorized /
     pairing accepted, continue — do NOT wait for 8 tools on this page.
5. Same tab: `goto` `https://chatgpt.com/?temporary-chat=true` (one personalized
   Temporary Chat per Codex session — see Temporary chats). Verify the
   connector is available there, send the boot prompt from `docs/protocol.md`
   §Boot Prompt, then (same chat) send:
   `Use the "<connectorName>" connector: call workspace_info and read hello-style top-level file. Reply with the workspace name.`
   Confirm the reply matches `workspaceName` (wait per **In-app browser** §8).
   Never save this chat's URL; record the task locally with `c2c record`.
   markDeliverable.
6. Report to the user exactly in this shape (no internals):

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

If a login wall appears (ChatGPT, Cloudflare): stop, tell the user the ONE thing
to do ("请登录 ChatGPT，完成后告诉我'好了'"), then continue.

## Temporary chats (one personalized Temporary Chat per Codex session)

C2C work runs in ChatGPT **Temporary Chats**: nothing is kept in chat history
or used for training, so the workspace's plans and code discussions stay
local. There is no saved conversation URL — continuity comes from the local
task records.

- **Start (once per Codex session)**: same iab tab, `goto`
  `https://chatgpt.com/?temporary-chat=true`. Before sending ANYTHING:
  choose **Personalized** in the Temporary Chat creation UI (temporary
  chats start non-personalized, connectors are only available in
  personalized ones, and this cannot be changed after the chat begins).
  Then verify the chat shows the Temporary label and the workspace
  connector is selectable. All three checks — Temporary, Personalized,
  connector — must pass before the first message.
- **Smoke gate (mandatory)**: right after the boot prompt, send the
  `workspace_info` check through the connector. If the connector is NOT
  available in the Temporary Chat, fall back deliberately: open a normal
  `https://chatgpt.com/` chat for this session, tell the user one line why
  (临时对话暂不支持连接器，已用普通对话代替，内容不落本地记录), and continue —
  do not send C2C messages into a chat without MCP.
- **Reuse** that Temporary Chat for all C2C work in this Codex session. Do
  not open a second temp chat mid-session, do not save its URL, and never
  run `c2c session set`.
- **Task state** lives in local records: at task start record
  `c2c record --task <id> --iteration 0 --state INIT --goal "<goal>"`; at
  EXECUTED/DONE/BLOCKED record state + summary + next step. This is what a
  replacement chat reconstructs from.
- **HANDOFF** is only for continuing a NON-terminal task in a replacement
  chat (previous temp chat lost/closed, or visibly lagging). Reconstruct the
  brief from local records: `c2c record`-backed `execution_summary` with a
  sufficient limit (e.g. `{"limit": 50}`), filtered to the current
  `taskId` — the default 5 records can lose the original INIT/goal after
  several iterations. Send the boot prompt, then the HANDOFF brief (goal,
  progress, current state, known issues, next expected step). A brand-new
  task needs only Boot Prompt + INIT — no HANDOFF.

## Workflow: coding task（"使用 Codex with ChatGPT 完成 XXX"）

Protocol states: INIT → PLAN → EXECUTING → EXECUTED → REVIEW → (PLAN | DONE | BLOCKED).
All control messages start with `[C2C]`. Keep Codex→ChatGPT messages under 1 KB.
ChatGPT's replies are expected to be substantive (see step 3). Docs: `docs/protocol.md`.

0. `c2c tunnel status -w <workspace> --json`. If `effectiveSource` is
   `machine`, the machine-wide fixed address is in charge — there is nothing
   to choose. Otherwise, if `needsChoice`, follow **Connection choice** first
   (existing installs: ask once, then remember).
   Then `c2c doctor -w <workspace> --json` (auto-repairs). **Doctor gate:** if local
   is not green, do not open ChatGPT and do not send INIT. If
   `namedRepair.needed` is true, tell the user `namedRepair.userMessage`, run
   `c2c tunnel login --json` (their browser; Cloudflare exception), then doctor
   again. If `chatgptRepair.needed` is true, tell the user `chatgptRepair.userMessage`
   (one paragraph, no internals), run **Workflow: reconnect after address
   reclaim**, then doctor again and only continue when the gate is green.
   Generate task id: `c2c_` + 4 random hex chars. Record the task start
   locally: `c2c record -w <ws> --task <id> --iteration 0 --state INIT
   --goal "<the user's goal>"`.
1. Use this Codex session's Temporary Chat on the same iab tab: if the
   session has none yet, `goto`
   `https://chatgpt.com/?temporary-chat=true` and verify the connector is
   available (see **Temporary chats** smoke gate). Foreground + markHandoff.
   In a NEW temp chat first send the boot prompt from
   `docs/protocol.md` §Boot Prompt. Never save the chat URL. Do not use the
   browser to re-read code MCP already provides. After sending a control
   message, wait per **In-app browser** §8.
2. Send INIT with the user's goal:

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
<user's goal, one paragraph>

INSTRUCTION:
Inspect the connected workspace through the Codex with ChatGPT MCP connector.
Produce a C2C PLAN message.
```

3. Wait for ChatGPT's `STATE: PLAN` reply (**In-app browser** §8 — short DOM
   checks, same tab; do not treat a 5-minute browser timeout as failure).
   Read GOAL/ACTIONS/TESTS/SUCCESS_CRITERIA.
   A good PLAN also carries RATIONALE and concrete natural-language edit
   suggestions (which file, what to change, why). If the reply is a bare
   one-liner with no rationale or file-level guidance, ask once:
   "Please expand the plan with rationale and concrete per-file suggestions."
4. Execute the plan yourself with your own harness (your tools, your judgment;
   ChatGPT does not micro-manage tool calls).
5. Record the execution so ChatGPT can read it via MCP — include the
   continuity fields at every meaningful transition (INIT recorded goal at
   step 0):
   `c2c record -w <ws> --task c2c_f81a --iteration 1 --changed-files "src/a.ts,src/b.ts" --tests "27 passed" --exit-status ok --state EXECUTED --summary "implemented X, tests pass" --next-step "independent diff review"`
   On DONE/BLOCKED record the terminal state + summary the same way.
6. Send EXECUTED (no diffs, no logs):

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
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
8. Loop. Respect maxIterations (`.c2c.json`, default 12). At the limit, pause and ask
   the user: "已完成 12 轮协作，仍有未解决问题，是否继续？"
9. On DONE: summarize the result to the user in plain language.
10. On BLOCKED: read ChatGPT's reason, fix what you can, or surface the single
    decision the user must make.

## Workflow: disconnect（"断开 ChatGPT"）

1. `c2c unpair -w <workspace>` (revokes all tokens immediately).
2. Optionally remove the connector on the same iab tab via
   `https://chatgpt.com/plugins` (foreground + markHandoff). Only touch
   this workspace's `connectorName`.
3. Tell the user: "已断开 ChatGPT 对该项目的访问。"

## Workflow: reconnect after address reclaim（全关掉以后地址失效）

This is the normal case when the user quit Codex / the terminal / the machine:
the previous public address is gone. Doctor already started a new one.
`connectorAction: "update"` means Delete + create again — not Reconnect.

`c2c doctor --json` will look like:
`{ "chatgptRepair": { "needed": true, "connectorAction": "update", "connectorName": "...", "userMessage": "...", "mcpUrl": "...", "pairingCode": "...", "pages": { ... } } }`

1. Tell the user exactly `chatgptRepair.userMessage`. Then you repair. Do not
   ask them to click around ChatGPT unless a login wall appears. Do not open
   the C2C chat and do not send `[C2C]` until this repair finishes and a
   follow-up doctor is green. Never "try a message first to see if it works".
2. Same one iab tab as setup (foreground + markHandoff). Settings URLs only
   until Connected — never hunt menus:
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
   - 插件总管（只用来 Delete）: `https://chatgpt.com/plugins`
   - 加插件（Delete 之后必走）: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
3. Operate ONLY on `chatgptRepair.connectorName`. Never touch another
   workspace's connector.
   - If that exact name exists on the plugins hub: **Delete** it. Confirm the
     delete if ChatGPT asks. **Never click Reconnect, Refresh, Connect, or
     Edit** on the old card — the old Server URL is dead and the page will
     hang on "This site cannot be reached".
   - Then `goto` the 加插件 URL and create that **same** `connectorName`
     (do not invent a second name):
      - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
      - Server URL: `chatgptRepair.mcpUrl`
      - Authentication: OAuth
     Then Connect / Authorize and type `chatgptRepair.pairingCode`
     (or `c2c pair --json` if it expired). Continue as soon as it is Connected —
     do not wait for 8 tools on the settings page.
   - If the name is already gone, skip Delete and only create.
4. `c2c doctor --json` again. Only after the Doctor gate is green: continue in
   this session's Temporary Chat if it is still open; otherwise open a fresh
   one (Temporary chats). Do not start a new audit/task chat just because the
   address changed.
5. If the session's chat was lost mid-task, follow Temporary chats → HANDOFF:
   new temp chat, boot prompt, HANDOFF brief from the local task records.
   No file re-uploading (the workspace lives in MCP).

## Workflow: repair（anything looks broken）

1. `c2c doctor -w <workspace> --json`. Doctor gate: do not open ChatGPT / send
   `[C2C]` until local is green, except reconnect settings pages.
2. If `namedRepair.needed`, tell the user `namedRepair.userMessage`, run
   `c2c tunnel login --json`, then doctor again. Do not Delete the connector.
3. If `chatgptRepair.needed`, follow **reconnect after address reclaim**, then
   doctor again.
4. Otherwise apply the recovery map. Only involve the user for login / 2FA /
   CAPTCHA — one action.

## Recovery map

| Symptom | Action |
| --- | --- |
| Bridge not running | `c2c start` (doctor does this automatically) |
| Tunnel dead / URL unreachable / 全关掉后连接失效 | `c2c doctor` → if `namedRepair.needed`, login to Cloudflare and doctor again (do not Delete). If `chatgptRepair.needed`, tell the user the message, then **Delete** THIS workspace's connector only (`connectorName`) and create it again. Never Reconnect. |
| ChatGPT says tool call failed / 401 | token expired or revoked → re-pair (new pairing code + authorize) |
| Pairing code rejected/expired | `c2c pair --json` for a fresh code |
| Port conflict | handled automatically; never surface to the user |
| Every new chat “repairs” / cannot write the log or settings directory | `c2c sandbox-allow --json` (once). Do not ask the user. |
| cloudflared missing | install it yourself (brew/winget), then retry |
| Start fails with "The fixed address … is currently served by workspace …" | Another workspace's bridge holds that hostname. Never kill it yourself — tell the user which workspace holds it and ask whether to move it (run `c2c stop` in that workspace, then start here) or keep it where it is. |
