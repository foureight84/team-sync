# Harness-bound mode — run only while an agent is coding

Instead of a persistent pm2/system service, team-sync can bind its lifecycle to
your **AI coding harness's session**. The leaf node and the project daemon start
when a harness opens a session on a broadcast-enabled project, and stop when the
session closes. Nothing runs while you're not coding.

```
harness session opens  →  node tooling/session/session.js up
harness session closes →  node tooling/session/session.js down
```

This is often the better default:
- **Isolated** — only runs for projects an agent is actively working on.
- **Zero idle cost** — no background process between sessions.
- **No gap in correctness** — JetStream's durable, per-project consumer replays
  everything missed the next time a session starts (see
  [`docs/SETUP.md`](SETUP.md) → offline/replay).

## How it stays correct

The session manager (`tooling/session/session.js`) is built for the messy
realities of hooks:

| Concern | Handling |
| --- | --- |
| Hooks are short-lived but the daemon must outlive them | `up` spawns the leaf + daemon **detached** (`unref`) and returns immediately |
| Hooks must not block / break the harness | every command logs errors and **always exits 0** |
| Many sessions / projects on one machine | **reference-counted** — one token file per session under `~/.team-sync/sessions/`; the shared leaf stops only when the last session ends |
| A crashed harness fires no "down" | every command first **GCs** tokens whose owning pid is dead or older than `SYNC_SESSION_TTL_MS` (default 12h), then reconciles |
| Private projects | no `team-sync.json` / `broadcast:false` ⇒ silent no-op, never starts anything |
| `/clear` in Claude | `SessionEnd reason:"clear"` is ignored (the process keeps running) |

`up`/`down` read `session_id` and `cwd` from the hook's **stdin JSON** when
present, so the same launcher works across harnesses; `--root`, `--session`,
`--harness`, and `--pid` flags override.

## Wiring per harness

### Claude Code  ✅ shipped

[`.claude/settings.json`](../.claude/settings.json) is committed and ready:
`SessionStart` (`startup`, `resume`) → `up`, `SessionEnd` → `down`. Claude
delivers `{session_id, cwd, source, reason}` on stdin. On first run Claude
prompts you to **trust** the project's hooks — accept once per machine.

### Other harnesses — generic contract

Any harness that can run a command on session open/close can drive this. The
contract is just:

```bash
# on session start
node /path/to/team-sync/tooling/session/session.js up   --harness <name> --root <projectDir>
# on session end
node /path/to/team-sync/tooling/session/session.js down  --harness <name> --root <projectDir>
```

If team-sync is installed as a dependency, use the bin instead of a path:

```bash
team-sync-session up   --harness <name> --root "$PWD"
team-sync-session down --harness <name> --root "$PWD"
```

Pass the harness's own session identifier with `--session <id>` (or pipe the
hook's JSON to stdin and the launcher will pick up `session_id`/`cwd`). Pass
`--pid <harnessPid>` so crash-GC can detect a dead session.

- **pi.dev** — wire `up`/`down` to its session start/stop lifecycle hooks.
  *(I haven't verified pi.dev's exact hook names/payload — confirm against its
  docs, or ask me to research it and I'll fill in the precise config.)*
- **Hermes** — same contract via its session lifecycle hooks. *(Exact hook
  surface unverified — needs confirmation.)*

### Safety net for any harness

Because GC runs on every invocation, you can add a periodic `gc` (cron, or a
per-prompt hook) to reap sessions from harnesses that don't reliably fire a
"session end":

```bash
node tooling/session/session.js gc
```

## Inspecting & manual control

```bash
npm run session:status     # active sessions + leaf/daemon pids
npm run session:gc         # reap dead sessions, reconcile
npm run session:up         # manual start (uses cwd)
npm run session:down       # manual stop
```

Logs: `~/.team-sync/logs/session.log` (lifecycle) and `supervisor.log`
(leaf/daemon stdout).

## Relationship to pm2 mode

Harness-bound and pm2 modes share the **same** machine leaf config and daemon —
they're two supervisors over one design. Pick one per machine:

- **Harness-bound** (this doc) — recommended for developer laptops.
- **pm2 / always-on** ([`docs/SETUP.md`](SETUP.md)) — for a shared box, a
  build agent, or anyone who wants sync running 24/7 regardless of editor state.

Don't run both for the same project at once — they'd start duplicate daemons.
