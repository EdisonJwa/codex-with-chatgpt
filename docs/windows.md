# Windows notes

Windows is a first-class platform for C2C (the project itself is developed on
Windows), but it behaves differently from macOS/Linux in the exact areas V2
touches most: process lifecycle, tunnels, and file handling. This page records
the quirks we rely on or work around. (Inspired by oracle's `windows-work.md`,
per v2-design §13.8.)

## Process lifecycle

- **No graceful signals.** `process.kill(pid, "SIGTERM")` on Windows terminates
  unconditionally — handlers never run. The host's cloudflared child is
  therefore stopped by terminating the process directly, and shutdown paths
  must never depend on signal handlers alone (`c2c stop` uses the admin API;
  SIGTERM handling is a Unix convenience).
- **`windowsHide: true`** is set on every spawn so cloudflared and daemonized
  hosts never flash a console window.
- **Detached daemons.** The host is spawned `detached` + `unref` so it
  outlives the CLI. If a host appears stuck, check `runtime/host.json` (pid +
  instanceId) and kill the recorded pid; `c2c doctor` detects stale records
  and fails authenticated adoption rather than guessing.

## Tunnels

- `cloudflared` installs via `winget install Cloudflare.cloudflared`. The
  machine `tunnel.json` credentials file path is absolute; moving it breaks
  the named tunnel silently — `c2c doctor` flags unreadable credentials.
- Quick Tunnel URLs rotate on every restart by design. On Windows this also
  means a reboot always rotates the URL; use the machine named-tunnel mode
  (`c2c tunnel set ...`) for a stable connector URL.

## Files & filesystem

- **chmod is advisory.** Windows ignores `0o600`; sensitive state
  (`host.json`, `auth/*.json`, `executions/`, `audit/`) relies on the user
  profile's default ACLs (`%LOCALAPPDATA%\codex-with-chatgpt`). Don't move the
  state dir to a shared location.
- **Atomic writes.** `renameSync` over an existing file works (Node uses
  `MOVEFILE_REPLACE_EXISTING`), so temp+rename stays atomic on NTFS. Atomicity
  is lost on FAT/exFAT volumes — keep the state dir on NTFS.
- **CRLF.** Git may check files out with CRLF; the JSONL stores (records,
  audit) are written by the app with `\n` and tolerate both. Don't edit them
  by hand.
- **Path casing.** NTFS is case-insensitive but case-preserving; canonical
  realpaths from `fs.realpathSync.native` are what path containment uses, so
  `C:\Repo` and `c:\repo` are the same workspace, not an escape vector.
- **Long paths.** Repos deep inside `node_modules` can exceed MAX_PATH. Node
  handles long paths internally, but `git` subprocesses may not — prefer
  shallow workspace roots.

## Loopback & firewall

- The host binds `127.0.0.1` only. The first start may trigger a Windows
  Firewall prompt for Node.js — allow it (loopback is not externally
  reachable either way, but the prompt blocks startup until answered).
- Proxy environment variables (`HTTP_PROXY` etc.) can break `fetch` from the
  CLI to loopback if a proxy refuses local traffic; C2C does not set
  `NO_PROXY` for you. If `c2c status` cannot reach a visibly running host,
  check proxy env first.
