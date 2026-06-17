# AI Agent Operational Directive: Real-Time Context & Graph Loop

You are an advanced, autonomous AI coding agent operating in a high-velocity,
multi-agent engineering team. To prevent code regression, duplicate features,
and context rot, you must adhere to this strict execution lifecycle.

---

## 1. Absolute Context Boundaries
- **Primary Source of Truth (Structural):** Use your active Model Context
  Protocol (MCP) tool connection to `graphify` to analyze code structures,
  dependency trees, and import maps. **Do not guess or hallucinate code paths.**
- **Primary Source of Truth (Intent):** Before changing any file, check the
  `.context/live-logs/` directory. If a peer log file indicates that a
  component is currently being refactored, you are strictly prohibited from
  touching it until the change log resolves or you clarify boundaries with the
  human.

---

## 2. Pre-Flight Execution Steps (Before Writing Code)
Before you write a single line of code, execute these tool steps in sequence:
1. Query Graphify to see what dependencies flow into the target code file —
   via your MCP tool connection, or on the CLI with
   `graphify explain "<symbol or file>"` and
   `graphify path "<A>" "<B>"` (reads `graphify-out/graph.json`).
2. Read the latest files inside `.context/live-logs/` to ingest real-time
   updates broadcast by other agents in the last 60 minutes.
3. Verify that your intended implementation does not violate definitions set in
   the project root level `CLAUDE.md` or `AGENTS.md`.

---

## 3. Post-Task Synchronization (Mandatory Execution Loop)
The moment you complete a feature, fix a bug, or alter a schema, you MUST run
the synchronization pipeline. Do not wait for the human to ask you to do this.

### Step A: Generate the OKF Payload
Construct an Open Knowledge Format (OKF) markdown block. It must strictly mirror
the layout in [`.context/templates/okf-event.md`](.context/templates/okf-event.md)
(full schema in [`docs/OKF.md`](docs/OKF.md)):

```markdown
---
type: log_event
title: "[Action Verb] Short description of what you did"
author: "YourAgentIdentity/HumanOwnerName"
timestamp: "INSERT_CURRENT_ISO_TIMESTAMP"
impacted_files: [/src/path/to/file1.ts, /src/path/to/file2.ts]
breaking: false
---
### Summary of Changes
- Explicitly state structural alterations, API changes, or new environment variables.
- Detail any newly introduced internal dependencies.

### Downstream Impact for Parallel Agents
- State what other modules or features must be updated or re-verified by other agents because of your change.
```

### Step B: Broadcast via NATS
Write the compiled markdown block to a temporary file (e.g.
`.context/temp-event.md`) and immediately publish it to the team:

```bash
node tooling/sync-daemon.js --publish .context/temp-event.md
```

The publisher validates the OKF schema before broadcasting; if it reports
errors, fix the frontmatter and re-run.

### Step C: Refresh Local AST Graph
Re-extract your local code so your Graphify map matches your new edits:

```bash
graphify update .
```

(If you run `graphify watch .` as a background daemon, this happens
automatically and you can skip the manual step.)

Once verified, clean up the temporary event file and report your success to the
human developer.

---

## 4. Git Lifecycle: Keep the Local Graph Fresh
The Graphify graph (`graphify-out/graph.json`) is **local and per-machine**. Any
git operation that mutates the working tree desynchronizes it from the code on
disk. You are therefore REQUIRED to re-extract the graph at these points:

- **After every commit** — your committed edits must be reflected before your
  next Graphify query.
- **After every pull / merge / rebase** — incoming peer commits change files you
  did not author; querying a stale graph will produce wrong dependency answers.
- **After switching branches** (`git checkout` / `git switch`).

In each case, run:

```bash
graphify update .
```

> Do not trust a Graphify query taken before completing this step following a
> commit or pull — treat the graph as stale until `graphify update .` succeeds.

**Automate it.** This repo ships the hooks that enforce it —
`post-commit`, `post-merge` (fires on `git pull`), `post-rewrite` (fires on
`git rebase` / `--amend`), and `post-checkout` (branch switches). Install them
once per clone:

```bash
npm run hooks:install      # or: sh tooling/git-hooks/install.sh
```

The hook sources live in [`tooling/git-hooks/`](tooling/git-hooks/) and run
`graphify update .` automatically. Running `graphify watch .` as a background
daemon also covers this, since it rebuilds on file changes regardless of how
they arrived.
