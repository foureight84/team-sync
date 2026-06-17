# Open Knowledge Format (OKF)

OKF is the wire format for context communication in team-sync. Every
architectural change or task execution is captured as **plain Markdown with
strict YAML frontmatter** — human-readable in a diff, machine-parseable by the
daemon.

The schema is enforced in code by [`tooling/okf.js`](../tooling/okf.js); the
publisher rejects invalid events before they ever hit NATS, and the daemon
drops malformed inbound events rather than materialising them.

## `log_event` schema

```markdown
---
type: log_event                       # required — must be exactly "log_event"
title: "[Verb] short description"      # required — human summary, used for the log filename
author: "AgentId/HumanOwner"           # required
timestamp: "2026-06-17T13:10:00Z"      # required — ISO-8601
impacted_files: [/src/a.ts, /src/b.ts] # required — list (may be empty); drives graphify rebuild
breaking: false                        # required — boolean
---
### Summary of Changes
- Structural alterations, API changes, new environment variables.
- Newly introduced internal dependencies.

### Downstream Impact for Parallel Agents
- What other modules/features must be re-verified because of this change.
```

### Field rules

| Field            | Type      | Notes                                                        |
| ---------------- | --------- | ------------------------------------------------------------ |
| `type`           | string    | Must equal `log_event`.                                      |
| `title`          | string    | Slugified into the live-log filename.                        |
| `author`         | string    | `AgentIdentity/HumanOwnerName`.                              |
| `timestamp`      | string    | ISO-8601; must parse via `Date.parse`.                       |
| `impacted_files` | list      | Paths touched. The daemon re-extracts the graph (`graphify update .`) when these arrive. |
| `breaking`       | boolean   | `true` surfaces a `[BREAKING]` marker in the daemon log.     |

## Lifecycle

1. An agent finishes a task and authors an OKF block to `.context/temp-event.md`.
2. `node tooling/sync-daemon.js --publish .context/temp-event.md` validates it
   and publishes to the `TEAM_SYNC` JetStream stream.
3. Every peer's daemon receives the delta, writes it to
   `.context/live-logs/<timestamp>-<slug>.md`, and triggers a Graphify
   re-extraction (`graphify update .`) so the local graph reflects the
   `impacted_files`.
4. The publishing agent cleans up its temp file and reports success.
