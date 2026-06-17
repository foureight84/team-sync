# Always-on setup (pm2) — keeping team-sync running 24/7

> ### ⚠️ Most people don't need this. Read first.
>
> The **default** way to run team-sync is **harness-bound mode**
> ([`docs/HARNESS.md`](HARNESS.md)) — the leaf node and daemon are started by
> your AI coding session and stop when it closes. **No pm2, no installed
> service, nothing running when you're not coding.** For a developer on a
> laptop, use that and ignore this file.
>
> **Use this always-on (pm2) mode only when there is no interactive harness
> session to bind the lifecycle to**, i.e. you need sync running continuously
> regardless of whether an editor is open. Typical cases:
>
> - a **shared dev box / server** several people reach into
> - a **build / CI agent** or automation host that publishes or consumes events
>   without an interactive harness
> - an editor or workflow whose harness **has no session hooks** to wire `up`/`down`
> - you simply want the daemon up **24/7** and surviving reboots
>
> Pick **one** mode per machine — don't run pm2 and harness-bound for the same
> project at once, or you'll get duplicate daemons.

In always-on mode, team-sync runs as two long-lived background processes per
machine, supervised by [**pm2**](https://pm2.keymetrics.io/) so they
**auto-restart on crash** and **start on boot**. Setup is split into two tiers.

```
MACHINE TIER  (once per laptop)            PROJECT TIER  (once per repo)
  npm run setup:machine                      cd my-project && npm run enroll
   • installs pm2                             • reads ./team-sync.json
   • generates ~/.team-sync/leaf.conf         • registers the project
   • starts the shared leaf node (pm2)        • adds its hub to the leaf
   • pm2 save + pm2 startup (boot)            • starts a project-scoped daemon
```

## Why two tiers

The **leaf node is machine-global** — it's a dumb, buffered uplink to the hub
and has no notion of projects. The **daemon is per-project** — it watches one
repo, runs Graphify there, and writes to that repo's `.context/live-logs/`.
Project identity lives in the **subject namespace**, derived deterministically
from the project id: `team.sync.<project>.events.<agent>` and stream
`TEAM_SYNC_<PROJECT>`.

This means:
- Switching projects needs **no mode switch** — every enrolled project's daemon
  runs concurrently, each bound to its own repo. The publisher derives its
  context from the working directory it's invoked in.
- Multiple projects on one machine never collide on the port (one leaf) and
  never cross-contaminate each other's logs (separate subjects + streams).

## Team vs. private projects (opt-in)

A project broadcasts **only if it's enrolled**, and enrollment requires a
committed `team-sync.json`:

```jsonc
{
  "project": "acme-api",        // → subject team.sync.acme-api.*, stream TEAM_SYNC_ACME_API
  "broadcast": true,            // false or absent ⇒ never broadcast
  "hub": "nats://hub.acme.internal:7422"
}
```

- **Team project** → the file is committed, so every teammate who clones gets a
  daemon when they run `npm run enroll`.
- **Private project** → no `team-sync.json` ⇒ `enroll` refuses ⇒ no daemon ⇒
  the leaf never carries it. Privacy is the default, by *absence*.

The publisher enforces this too: `--publish` from a non-broadcast project errors
out instead of leaking events.

## Machine state (`~/.team-sync/`)

Never committed to any repo — it's per-machine:

```
~/.team-sync/
├── identity                 # this agent's id (default: hostname); edit to taste
├── registry.json            # source of truth: which projects are enrolled
├── leaf.conf                # GENERATED from registry (one remote per distinct hub)
├── leaf-store/              # JetStream local buffer (offline resilience)
└── apps/
    ├── leaf.config.cjs       # pm2 ecosystem for the leaf node
    └── <project>.config.cjs  # pm2 ecosystem per enrolled daemon
```

Override the location with `TEAM_SYNC_HOME`.

## Credentials

`team-sync.json` holds only the hub **host** — never secrets. Hub credentials
are resolved from the machine environment when the leaf config is generated:

```bash
export SYNC_HUB_USER=agent
export SYNC_HUB_PASSWORD=…      # e.g. in ~/.team-sync/.env, sourced by your shell
```

## Day-to-day commands

```bash
npm run setup:machine     # once per laptop
npm run enroll            # in a project dir — start syncing it
npm run leave             # in a project dir — stop syncing it
npm run ts:list           # registry + pm2 status

pm2 status                # all team-sync processes
pm2 logs team-sync-daemon-acme-api
pm2 restart team-sync-leaf
```

## Boot persistence & crash recovery

- **Crash** → pm2 restarts the process automatically (`autorestart: true`).
- **Reboot** → `pm2 save` snapshots the running set; the command printed by
  `pm2 startup` installs the OS hook that resurrects them at login.

## Alternative supervisors

pm2 is the default because one mechanism covers `nats-server` + Node across
macOS/Linux/Windows. If you'd rather use OS-native supervision:

- **macOS** — a `launchd` agent per process in `~/Library/LaunchAgents/` with
  `KeepAlive=true` (restart) and `RunAtLoad=true` (boot).
- **Linux** — `systemd --user` units with `Restart=always`, enabled via
  `systemctl --user enable --now` and `loginctl enable-linger <user>` so they
  run without an active login session.

The generated `~/.team-sync/leaf.conf` and the daemon's env contract
(`SYNC_PROJECT_ROOT`, `NATS_URL`, `TEAM_SYNC_HOME`) are supervisor-agnostic, so
swapping is mechanical.
