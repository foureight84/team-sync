import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Central, project-aware configuration for the team-sync tooling.
 *
 * Identity flows from three places, in order of specificity:
 *   1. Environment variables (always win — used by pm2 ecosystem files & CI).
 *   2. The per-project `team-sync.json` marker in SYNC_PROJECT_ROOT.
 *   3. Machine defaults (~/.team-sync/identity, hostname, basename).
 *
 * Because subjects and the stream name are *derived deterministically from the
 * project id*, every teammate's daemon and publisher agree on where a given
 * project's events live — no shared mutable config required.
 */

const HOME = os.homedir();
export const MACHINE_DIR =
  process.env.TEAM_SYNC_HOME || path.join(HOME, ".team-sync");

const projectRoot = path.resolve(process.env.SYNC_PROJECT_ROOT || process.cwd());

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Load the committed `team-sync.json` marker, if present. */
export function loadProjectManifest(root = projectRoot) {
  return readJsonSafe(path.join(root, "team-sync.json"));
}

const manifest = loadProjectManifest() || {};

/** Sanitize a project id into a NATS-safe token (subjects forbid spaces/dots). */
export function projectToken(id) {
  return String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

// Project id: manifest wins, else the repo directory name.
const project = projectToken(manifest.project || path.basename(projectRoot));

// Stable machine identity: env > ~/.team-sync/identity > hostname.
// Sanitized to a single NATS subject token (no dots/spaces).
const agentId = (
  process.env.AGENT_ID ||
  readTextSafe(path.join(MACHINE_DIR, "identity")) ||
  os.hostname()
).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

export const config = {
  /** This project's stable id (token form). */
  project,

  /** Whether this project opted into broadcasting (team vs. private project). */
  broadcast: process.env.SYNC_BROADCAST
    ? process.env.SYNC_BROADCAST !== "false"
    : manifest.broadcast === true,

  /** Hub the project's leaf-node remote points at (host:port, no creds). */
  hub: process.env.SYNC_HUB || manifest.hub || null,

  /** URL of the NATS endpoint to connect to — normally the LOCAL leaf node. */
  natsUrl: process.env.NATS_URL || "nats://127.0.0.1:4222",

  /** Per-project JetStream stream; deterministic from the project id. */
  stream:
    process.env.SYNC_STREAM || `TEAM_SYNC_${project.replace(/-/g, "_").toUpperCase()}`,

  /** Per-project subject namespace. Per-agent events go to `<prefix>.<agentId>`. */
  subjectPrefix:
    process.env.SYNC_SUBJECT_PREFIX || `team.sync.${project}.events`,

  /** Identity broadcast on every event. */
  agentId,

  /** Absolute project root the daemon operates against. */
  projectRoot,

  /** Where inbound peer events are materialised for agents to read. */
  liveLogsDir: path.resolve(
    projectRoot,
    process.env.SYNC_LIVE_LOGS_DIR || ".context/live-logs",
  ),

  /** Durable consumer — keyed per machine AND project so replay is isolated. */
  durable:
    process.env.SYNC_DURABLE || `sync-${project}-${agentId}`.replace(/[^a-zA-Z0-9_-]/g, "-"),

  /** Command used to rebuild the local Graphify AST map after a peer edit. */
  graphifyCmd: process.env.GRAPHIFY_CMD || "graphify update .",

  /** Debounce window (ms) for coalescing graphify rebuilds under a burst. */
  graphifyDebounceMs: Number(process.env.GRAPHIFY_DEBOUNCE_MS || 1500),

  /** When true, the daemon ignores events it published itself (avoids echo). */
  ignoreSelf: process.env.SYNC_IGNORE_SELF !== "false",
};

/** NATS message headers used to carry routing metadata alongside the OKF body. */
export const HEADERS = {
  agent: "x-sync-agent",
  eventId: "x-sync-event-id",
};

export function eventSubject(agentId = config.agentId) {
  return `${config.subjectPrefix}.${agentId}`;
}

/** Wildcard subject capturing events from every agent for this project. */
export function allEventsSubject() {
  return `${config.subjectPrefix}.>`;
}
