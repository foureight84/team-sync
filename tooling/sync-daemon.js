#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { connect } from "@nats-io/transport-node";
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
} from "@nats-io/jetstream";

import { config, HEADERS, eventSubject, allEventsSubject } from "./config.js";
import { parseOkf, validateOkf, slugify } from "./okf.js";

/**
 * tooling/sync-daemon.js — the bridge between NATS and the filesystem.
 *
 * Modes:
 *   (default)            run forever: subscribe to peer events, write them to
 *                        .context/live-logs/, and trigger incremental Graphify
 *                        rebuilds.
 *   --publish <file>     publish one OKF markdown file as a context delta and
 *                        exit.
 *   --once               drain any missed events (offline catch-up) and exit.
 */

function log(...args) {
  console.log(`[sync-daemon ${new Date().toISOString()}]`, ...args);
}

function parseArgs(argv) {
  const args = { mode: "daemon", file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--publish") {
      args.mode = "publish";
      args.file = argv[++i];
    } else if (a === "--once") {
      args.mode = "once";
    } else if (a === "--help" || a === "-h") {
      args.mode = "help";
    }
  }
  return args;
}

async function connectNats() {
  const nc = await connect({
    servers: config.natsUrl,
    name: `sync-daemon/${config.agentId}`,
    maxReconnectAttempts: -1, // retry forever — the leaf node may be down
    reconnectTimeWait: 1000,
  });

  // Surface connection lifecycle so an operator can see offline/online flips.
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === "disconnect" || s.type === "reconnect") {
        log(`nats ${s.type}: ${JSON.stringify(s.data ?? "")}`);
      }
    }
  })().catch(() => {});

  return nc;
}

/**
 * Ensure the JetStream stream exists. JetStream is what gives us persistence
 * and replay: an agent that was offline still receives every delta it missed.
 */
async function ensureStream(nc) {
  const jsm = await jetstreamManager(nc);
  const subjects = [allEventsSubject()];
  try {
    await jsm.streams.add({
      name: config.stream,
      subjects,
      // Keep the running architectural narrative; drop only the oldest.
      max_msgs: 100_000,
      discard: "old",
    });
    log(`created stream ${config.stream} (${subjects.join(", ")})`);
  } catch (err) {
    // Already exists — reconcile the subject list in case the prefix changed.
    const info = await jsm.streams.info(config.stream).catch(() => null);
    if (!info) throw err;
    const have = new Set(info.config.subjects ?? []);
    if (!subjects.every((s) => have.has(s))) {
      info.config.subjects = [...new Set([...(info.config.subjects ?? []), ...subjects])];
      await jsm.streams.update(info.config);
      log(`updated stream ${config.stream} subjects`);
    }
  }
  return jsm;
}

// ---------------------------------------------------------------------------
// Publish mode
// ---------------------------------------------------------------------------

async function publish(file) {
  if (!file) {
    throw new Error("usage: sync-daemon.js --publish <path-to-okf.md>");
  }
  if (!config.broadcast) {
    throw new Error(
      `project "${config.project}" is not enrolled for broadcast ` +
        `(no team-sync.json with broadcast:true). Refusing to publish. ` +
        `Run \`npm run enroll\` to opt this project in.`,
    );
  }

  const abs = path.resolve(config.projectRoot, file);
  const raw = await readFile(abs, "utf8");
  const { data } = parseOkf(raw);

  const errors = validateOkf(data);
  if (errors.length) {
    throw new Error(
      `OKF validation failed for ${file}:\n  - ${errors.join("\n  - ")}`,
    );
  }

  const nc = await connectNats();
  try {
    await ensureStream(nc);
    const js = jetstream(nc);
    const eventId = `${config.agentId}-${data.timestamp}`;

    const headers = nc.headers ? nc.headers() : undefined;
    if (headers) {
      headers.set(HEADERS.agent, config.agentId);
      headers.set(HEADERS.eventId, eventId);
    }

    const ack = await js.publish(
      eventSubject(),
      new TextEncoder().encode(raw),
      { msgID: eventId, headers }, // msgID gives JetStream dedupe on retries
    );
    log(`published "${data.title}" -> ${config.stream} seq=${ack.seq}`);
  } finally {
    await nc.drain();
  }
}

// ---------------------------------------------------------------------------
// Inbound handling: NATS -> filesystem -> Graphify
// ---------------------------------------------------------------------------

function makeGraphifyTrigger() {
  let timer = null;
  let pending = new Set();

  function run() {
    timer = null;
    const files = [...pending];
    pending = new Set();
    log(`graphify rebuild for ${files.length} impacted file(s)`);

    const [cmd, ...cmdArgs] = config.graphifyCmd.split(" ");
    const child = spawn(cmd, cmdArgs, {
      cwd: config.projectRoot,
      stdio: "inherit",
    });
    child.on("error", (err) =>
      log(`graphify failed to start (${err.message}) — is it installed?`),
    );
  }

  return function trigger(impactedFiles = []) {
    impactedFiles.forEach((f) => pending.add(f));
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, config.graphifyDebounceMs);
  };
}

async function writeLiveLog(data, raw) {
  await mkdir(config.liveLogsDir, { recursive: true });
  const stamp = (data.timestamp || new Date().toISOString()).replace(/[:.]/g, "-");
  const filename = `${stamp}-${slugify(data.title)}.md`;
  const dest = path.join(config.liveLogsDir, filename);
  await writeFile(dest, raw, "utf8");
  return dest;
}

async function consumeEvents(nc, { once = false } = {}) {
  const jsm = await ensureStream(nc);
  const js = jetstream(nc);

  await jsm.consumers.add(config.stream, {
    durable_name: config.durable,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All, // replay everything we haven't acked
    filter_subject: allEventsSubject(),
  }).catch(async (err) => {
    // Consumer already exists from a prior run — that's the normal path.
    const exists = await jsm.consumers.info(config.stream, config.durable).catch(() => null);
    if (!exists) throw err;
  });

  const consumer = await js.consumers.get(config.stream, config.durable);
  const trigger = makeGraphifyTrigger();
  const graphify = once ? null : trigger;

  const messages = await consumer.consume();
  log(
    once
      ? "draining missed events (catch-up)…"
      : `watching ${allEventsSubject()} -> ${config.liveLogsDir}`,
  );

  for await (const m of messages) {
    try {
      const fromAgent = m.headers?.get(HEADERS.agent);
      if (config.ignoreSelf && fromAgent && fromAgent === config.agentId) {
        m.ack();
        continue;
      }

      const raw = new TextDecoder().decode(m.data);
      const { data } = parseOkf(raw);
      const errors = validateOkf(data);
      if (errors.length) {
        log(`dropping malformed event seq=${m.seq}: ${errors.join("; ")}`);
        m.ack(); // poison message — ack so it doesn't redeliver forever
        continue;
      }

      const dest = await writeLiveLog(data, raw);
      log(
        `event seq=${m.seq} from ${fromAgent || data.author}: "${data.title}"` +
          `${data.breaking ? " [BREAKING]" : ""} -> ${path.relative(config.projectRoot, dest)}`,
      );

      graphify?.(data.impacted_files || []);
      m.ack();
    } catch (err) {
      log(`error processing seq=${m.seq}: ${err.message}`);
      m.nak(); // transient failure — let JetStream redeliver
    }

    if (once && m.info.pending === 0) break;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`team-sync daemon

Usage:
  node tooling/sync-daemon.js                 run the watcher (NATS -> .context/live-logs/ -> graphify)
  node tooling/sync-daemon.js --publish FILE  publish one OKF markdown file as a context delta
  node tooling/sync-daemon.js --once          drain missed events then exit (offline catch-up)
  node tooling/sync-daemon.js --help

Environment (see tooling/config.js for the full list):
  NATS_URL          ${config.natsUrl}
  SYNC_STREAM       ${config.stream}
  AGENT_ID          ${config.agentId}
  GRAPHIFY_CMD      ${config.graphifyCmd}

Graphify CLI reference:
  graphify update .            re-extract code and update graphify-out/graph.json (no LLM)
  graphify watch .             continuously rebuild the graph on file changes
  graphify explain "Node"      plain-language explanation of a node + neighbors
  graphify path "A" "B"        shortest dependency path between two nodes
`);
}

async function main() {
  const { mode, file } = parseArgs(process.argv.slice(2));

  if (mode === "help") return printHelp();
  if (mode === "publish") return publish(file);

  const nc = await connectNats();
  const shutdown = async () => {
    log("shutting down…");
    await nc.drain().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await consumeEvents(nc, { once: mode === "once" });

  if (mode === "once") await nc.drain();
}

main().catch((err) => {
  console.error(`[sync-daemon] fatal: ${err.message}`);
  process.exit(1);
});
