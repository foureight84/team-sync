# team-sync

**A coordination layer for teams running multiple AI coding agents on the same
codebase.** In one line: it keeps parallel AI agents semantically in sync so
they stop stepping on each other.

**The problem.** When several developers (and their agents) work a shared repo
in parallel, agents drift out of sync — they overwrite each other's changes,
rebuild logic that already exists, and act on stale assumptions about the
architecture, because each one only sees its own local context.

**The solution.** Three pieces working together:

- **OKF** — every change is broadcast as a structured Markdown+YAML event
  ("what I touched, what's now affected").
- **Graphify** — a Tree-sitter dependency graph agents query (over MCP) instead
  of guessing code relationships.
- **NATS leaf nodes + JetStream** — an offline-resilient message stream that
  fans those events to every teammate and replays whatever an offline machine
  missed.

A local daemon bridges them: it writes inbound peer events to
`.context/live-logs/` and refreshes the local graph, so each agent reads
real-time peer intent *and* accurate structure before editing. It runs **bound
to the AI harness session** (starts when you open a coding session, stops when
you close it), with an optional always-on pm2 mode for unattended machines.
Projects opt in explicitly via a committed `team-sync.json`, so private repos
never broadcast.

> 📊 New here? Open **[`docs/flow.html`](docs/flow.html)** in a browser for an
> interactive tour. This README is the **getting-started guide**.

---

## Prerequisites

| Need | Why | Install |
| --- | --- | --- |
| **Node.js ≥ 20** | runs the daemon + tooling (regardless of your app's language) | nodejs.org |
| **`nats-server`** | the local leaf node | `brew install nats-server` |
| **A central NATS hub** | the team's shared broker (one per team) | see [Stand up the hub](#stand-up-the-hub-once-per-team) |
| **`graphify`** *(optional)* | refresh the local code graph after peer edits | the `graphify` CLI/skill |
| **`pm2`** *(optional)* | only for always-on mode | auto-installed by `setup:machine` |

---

## The 30-second model

- The **leaf node** is **one per machine** — a buffered uplink to the hub. It
  knows nothing about projects.
- The **daemon** is **one per project** — it watches that repo, writes inbound
  peer events to `.context/live-logs/`, and refreshes Graphify.
- A project participates **only if it has a committed `team-sync.json`** with
  `"broadcast": true`. No marker = private = never broadcast.
- Subjects/streams are derived deterministically from the project id, so every
  teammate agrees with no shared config: `team.sync.<project>.events.*`.

Full architecture: [`docs/SETUP.md`](docs/SETUP.md) ·
[`docs/HARNESS.md`](docs/HARNESS.md) · [`docs/OKF.md`](docs/OKF.md).

---

## Path A — Start a NEW project

Use team-sync as the project skeleton; the tooling is already at the root.

```bash
git clone <this-repo-url> my-app        # or: degit / copy this directory
cd my-app
rm -rf .git && git init                 # make it your own repo
npm install                             # installs the 3 tooling deps

# build your application inside this directory as usual…
```

Then [configure the marker](#configure-team-syncjson) and
[pick a supervisor mode](#pick-a-supervisor-mode).

---

## Path B — Attach to an EXISTING project

Vendor the tooling into your project root (it lives alongside your app; Node is
only a tooling dependency — your app can be any language).

```bash
# from a clone of team-sync, copy the pieces into your project:
cd /path/to/your-project
SRC=/path/to/team-sync-clone

cp -R "$SRC/tooling"   ./tooling
cp -R "$SRC/.claude"   ./.claude          # Claude Code session hooks
cp    "$SRC/AGENTS.md" ./AGENTS.md        # agent operating manual
cp    "$SRC/team-sync.example.json" ./team-sync.example.json
mkdir -p .context/live-logs
```

Add the dependencies, scripts, and bins to your `package.json` (create one with
`npm init -y` if your project has none):

```jsonc
{
  "type": "module",
  "dependencies": {
    "@nats-io/jetstream": "^3.0.0",
    "@nats-io/transport-node": "^3.0.0",
    "gray-matter": "^4.0.3"
  },
  "scripts": {
    "hooks:install": "sh tooling/git-hooks/install.sh",
    "enroll": "node tooling/setup/manage.js enroll",
    "leave":  "node tooling/setup/manage.js leave",
    "ts:list": "node tooling/setup/manage.js list",
    "session:status": "node tooling/session/session.js status",
    "session:gc": "node tooling/session/session.js gc",
    "catchup": "node tooling/sync-daemon.js --once"
  }
}
```

```bash
npm install
```

> The committed `.claude/settings.json` calls
> `"$CLAUDE_PROJECT_DIR/tooling/session/session.js"`, so keep `tooling/` at the
> **project root**. If you prefer a subdirectory (e.g. `.team-sync/`), update
> those two paths in `.claude/settings.json` accordingly.

Then [configure the marker](#configure-team-syncjson) and
[pick a supervisor mode](#pick-a-supervisor-mode).

---

## Configure `team-sync.json`

This committed file is what opts the project in. Copy the example and edit it:

```bash
cp team-sync.example.json team-sync.json
```

```jsonc
{
  "project": "my-app",                       // → subject team.sync.my-app.events.*
  "broadcast": true,                         // false / absent ⇒ private, never syncs
  "hub": "nats://hub.yourteam.internal:7422" // your team's central hub (leaf port)
}
```

Hub **credentials are never committed** — each developer sets them in their
environment (e.g. in `~/.team-sync/.env` or their shell):

```bash
export SYNC_HUB_USER=agent
export SYNC_HUB_PASSWORD=…
```

---

## Pick a supervisor mode

Choose **one** per machine. Both share the same leaf + daemon.

### Mode 1 — Harness-bound *(recommended for laptops)*

The leaf + daemon run **only while an AI harness has a session open**, and stop
when it closes. JetStream replays anything missed next time. Details:
[`docs/HARNESS.md`](docs/HARNESS.md).

```bash
npm run hooks:install     # graphify update . on git commit/pull/rebase/checkout
# Claude Code: .claude/settings.json is already wired —
# just open a session in the project; accept the one-time "trust hooks" prompt.
```

Other harnesses (pi.dev, Hermes, …): wire their session start/stop to
`node tooling/session/session.js up|down` — see [`docs/HARNESS.md`](docs/HARNESS.md).

### Mode 2 — Always-on (pm2) *(shared boxes / build agents)*

Runs 24/7, auto-restarts, starts on boot. Details: [`docs/SETUP.md`](docs/SETUP.md).

```bash
npm run setup:machine     # installs pm2, starts the shared leaf, enables boot start
npm run enroll            # from the project dir — starts its daemon
npm run hooks:install
```

---

## Verify it's working

```bash
npm run session:status    # harness mode: active sessions + leaf/daemon pids
npm run ts:list           # pm2 mode: enrolled projects + pm2 status
```

Smoke-test the pipeline end to end (publish an OKF event → peers' live-logs):

```bash
cp .context/templates/okf-event.md .context/temp-event.md
# edit the frontmatter (set a real timestamp + impacted_files), then:
node tooling/sync-daemon.js --publish .context/temp-event.md
```

A peer's daemon writes it to their `.context/live-logs/<ts>-<slug>.md` and runs
`graphify update .`.

---

## What your agents do

Agents follow [`AGENTS.md`](AGENTS.md) automatically:

1. **Before editing** — query Graphify for dependencies and read
   `.context/live-logs/` for in-flight peer work.
2. **After a change** — author an OKF event and `--publish` it.
3. **On git events** — `graphify update .` keeps the local graph fresh (the
   installed hooks do this).

---

## Stand up the hub *(once per team)*

One person runs the central broker; everyone's `team-sync.json` points at it.

```bash
export SYNC_HUB_PASSWORD=…                 # used by nats/hub.conf
nats-server -c nats/hub.conf               # or: npm run hub
```

For production, replace the password auth in [`nats/hub.conf`](nats/hub.conf)
with NKEY/JWT credentials and put it behind TLS. Any managed NATS+JetStream
deployment works.

---

## Opt out / go private

- **Don't sync a project** → just don't create `team-sync.json` (or set
  `"broadcast": false`). The publisher and `enroll` both refuse private projects.
- **Stop syncing** → `npm run leave` (pm2) or close the session (harness mode).
- **Remove git hooks** → `npm run hooks:uninstall`.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `enroll`/publish "refusing… not enrolled" | missing `team-sync.json` or `broadcast:false` |
| leaf node won't start | `nats-server` not on PATH (`brew install nats-server`) |
| no graph refresh after peer edits | `graphify` not on PATH — the daemon logs and skips it |
| Claude hooks don't fire | accept the project-trust prompt; confirm `tooling/` is at root |
| harness crashed, daemon lingers | `npm run session:gc` reaps dead sessions |
| logs | `~/.team-sync/logs/session.log` and `supervisor.log` |

---

## Layout

```
your-project/
├── team-sync.json             # opt-in marker (committed for team projects)
├── AGENTS.md                  # operating manual your agents obey
├── .claude/settings.json      # Claude Code session hooks (harness-bound mode)
├── tooling/
│   ├── sync-daemon.js         # NATS <-> filesystem <-> graphify bridge
│   ├── okf.js · config.js     # OKF schema · project-aware config
│   ├── session/session.js     # harness-bound supervisor (up/down/gc/status)
│   ├── setup/                  # machine.js · manage.js · install-machine.sh
│   └── git-hooks/             # graphify update . on git events
├── nats/{hub,leaf}.conf       # NATS configs (hub for the team host)
├── docs/                      # OKF.md · SETUP.md · HARNESS.md · flow.html
└── .context/
    ├── live-logs/             # inbound peer events (runtime; git-ignored)
    └── templates/okf-event.md

~/.team-sync/                  # machine state (generated; never committed)
└── identity · registry.json · leaf.conf · leaf-store/ · sessions/ · logs/
```
