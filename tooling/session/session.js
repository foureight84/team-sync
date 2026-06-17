#!/usr/bin/env node
/**
 * Harness-bound supervisor for team-sync.
 *
 * Instead of a persistent pm2/system service, the leaf node + per-project
 * daemon run ONLY while an AI coding harness (Claude Code, pi.dev, Hermes, …)
 * has an open session on a broadcast-enabled project. Wire it to the harness's
 * session lifecycle hooks:
 *
 *     session start  ->  node tooling/session/session.js up
 *     session end    ->  node tooling/session/session.js down
 *
 * Design constraints handled here:
 *   • Hooks are short-lived and may BLOCK the harness — `up` spawns the daemon
 *     and leaf DETACHED and returns immediately, always exit 0.
 *   • Multiple sessions / projects share one leaf node — REFERENCE COUNTED via
 *     one token file per session under ~/.team-sync/sessions/.
 *   • A crashed harness fires no `down` — every command first GC's tokens whose
 *     owning pid is dead or older than the TTL, then reconciles processes.
 *   • Private projects (no team-sync.json / broadcast:false) are ignored.
 *
 * Session id + cwd are read from the hook's STDIN JSON when present (Claude
 * Code delivers {session_id, cwd, source, …}); flags/env override.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

import { loadProjectManifest } from "../config.js";
import {
  SESSIONS_DIR,
  LOG_DIR,
  LEAF_CONF,
  LEAF_PORT,
  projectToken,
  ensureMachineDirs,
  ensureIdentity,
  writeLeafConf,
} from "../setup/machine.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DAEMON = path.join(REPO_ROOT, "tooling", "sync-daemon.js");
const LEAF_PID = path.join(SESSIONS_DIR, "leaf.pid");
const LEAF_HUBS = path.join(SESSIONS_DIR, "leaf.hubs.json");
const SESSION_TTL_MS = Number(process.env.SYNC_SESSION_TTL_MS || 12 * 3600 * 1000);

// --------------------------------------------------------------------------
// stdin + args
// --------------------------------------------------------------------------
function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) f[a.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  }
  return f;
}

// --------------------------------------------------------------------------
// process helpers
// --------------------------------------------------------------------------
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours
  }
}

function readPid(file) {
  try {
    return Number(fs.readFileSync(file, "utf8").trim()) || null;
  } catch {
    return null;
  }
}

function spawnDetached(cmd, args, env) {
  const out = fs.openSync(path.join(LOG_DIR, "supervisor.log"), "a");
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...env },
  });
  child.unref();
  return child.pid;
}

function stop(pid) {
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function have(bin) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// session token bookkeeping (one file per live session)
// --------------------------------------------------------------------------
function projectDir(project) {
  return path.join(SESSIONS_DIR, project);
}

function listTokens() {
  ensureMachineDirs();
  const tokens = [];
  let projects = [];
  try {
    projects = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {}
  for (const project of projects) {
    const dir = projectDir(project);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        tokens.push({ ...t, project, file: path.join(dir, file) });
      } catch {
        fs.rmSync(path.join(dir, file), { force: true });
      }
    }
  }
  return tokens;
}

function gcTokens() {
  const now = Date.now();
  for (const t of listTokens()) {
    const stale = now - (t.startedAt || 0) > SESSION_TTL_MS;
    const dead = t.pid && !isAlive(t.pid);
    if (stale || dead) fs.rmSync(t.file, { force: true });
  }
}

// --------------------------------------------------------------------------
// reconcile desired vs. actual processes
// --------------------------------------------------------------------------
function ensureLeaf(hubs) {
  if (!have("nats-server")) {
    log("nats-server not on PATH — cannot start leaf node; daemon will retry.");
    return;
  }
  const desired = JSON.stringify([...new Set(hubs.filter(Boolean))].sort());
  const current = (() => {
    try {
      return JSON.stringify(JSON.parse(fs.readFileSync(LEAF_HUBS, "utf8")).sort());
    } catch {
      return null;
    }
  })();

  const pid = readPid(LEAF_PID);
  const running = isAlive(pid);

  if (running && current === desired) return; // already correct

  writeLeafConf(hubs);
  fs.writeFileSync(LEAF_HUBS, JSON.stringify([...new Set(hubs.filter(Boolean))]));

  if (running) {
    // hub set changed — restart so new remotes take effect
    stop(pid);
  }
  const newPid = spawnDetached("nats-server", ["-c", LEAF_CONF]);
  fs.writeFileSync(LEAF_PID, String(newPid));
  log(`leaf node started (pid ${newPid}, ${new Set(hubs.filter(Boolean)).size} hub remotes)`);
}

function stopLeaf() {
  const pid = readPid(LEAF_PID);
  if (isAlive(pid)) {
    stop(pid);
    log(`leaf node stopped (pid ${pid})`);
  }
  fs.rmSync(LEAF_PID, { force: true });
  fs.rmSync(LEAF_HUBS, { force: true });
}

function daemonPidFile(project) {
  return path.join(SESSIONS_DIR, `${project}.daemon.pid`);
}

function ensureDaemon(project, root) {
  const pidFile = daemonPidFile(project);
  if (isAlive(readPid(pidFile))) return;
  const pid = spawnDetached("node", [DAEMON], {
    SYNC_PROJECT_ROOT: root,
    NATS_URL: `nats://127.0.0.1:${LEAF_PORT}`,
    TEAM_SYNC_HOME: path.dirname(SESSIONS_DIR),
  });
  fs.writeFileSync(pidFile, String(pid));
  log(`daemon started for "${project}" (pid ${pid}) -> ${root}`);
}

function stopDaemon(project) {
  const pidFile = daemonPidFile(project);
  const pid = readPid(pidFile);
  if (isAlive(pid)) {
    stop(pid);
    log(`daemon stopped for "${project}" (pid ${pid})`);
  }
  fs.rmSync(pidFile, { force: true });
}

function reconcile() {
  gcTokens();
  const tokens = listTokens();

  // group surviving tokens by project
  const byProject = new Map();
  for (const t of tokens) {
    if (!byProject.has(t.project)) byProject.set(t.project, t);
  }

  // leaf: union of every active project's hub; stop entirely if no sessions
  if (tokens.length === 0) {
    for (const f of fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR) : []) {
      if (f.endsWith(".daemon.pid")) stopDaemon(f.replace(".daemon.pid", ""));
    }
    stopLeaf();
    return;
  }

  ensureLeaf(tokens.map((t) => t.hub));

  // start daemons for active projects, stop daemons for inactive ones
  const active = new Set(byProject.keys());
  for (const [project, t] of byProject) ensureDaemon(project, t.root);
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (f.endsWith(".daemon.pid")) {
      const p = f.replace(".daemon.pid", "");
      if (!active.has(p)) stopDaemon(p);
    }
  }
}

// --------------------------------------------------------------------------
// commands
// --------------------------------------------------------------------------
function log(msg) {
  try {
    ensureMachineDirs();
    fs.appendFileSync(
      path.join(LOG_DIR, "session.log"),
      `[${new Date().toISOString()}] ${msg}\n`,
    );
  } catch {}
}

function resolveContext(flags, stdin) {
  const root = path.resolve(
    flags.root || stdin.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  );
  const manifest = loadProjectManifest(root) || {};
  const project = projectToken(manifest.project || path.basename(root));
  const sessionId = String(
    flags.session || stdin.session_id || stdin.sessionId || `pid-${process.ppid}`,
  ).replace(/[^a-zA-Z0-9_-]/g, "-");
  return { root, manifest, project, sessionId };
}

function up(flags, stdin) {
  ensureMachineDirs();
  ensureIdentity();
  const { root, manifest, project, sessionId } = resolveContext(flags, stdin);

  if (manifest.broadcast !== true) {
    log(`up: "${project}" not broadcast-enabled (private) — no-op.`);
    return; // private project: do nothing, silently
  }
  if (!manifest.hub) {
    log(`up: "${project}" missing hub in team-sync.json — no-op.`);
    return;
  }

  fs.mkdirSync(projectDir(project), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir(project), `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      pid: Number(flags.pid) || process.ppid,
      root,
      hub: manifest.hub,
      harness: flags.harness || stdin.harness || "unknown",
      startedAt: Date.now(),
    }),
  );
  log(`up: session ${sessionId} (${flags.harness || "?"}) on "${project}"`);
  reconcile();
}

function down(flags, stdin) {
  // `/clear` ends a SessionEnd with reason "clear" but the harness keeps
  // running the same session — don't tear down on that.
  if (stdin.reason === "clear") {
    log(`down: ignoring reason=clear (session continues)`);
    return;
  }
  const { project, sessionId } = resolveContext(flags, stdin);
  const tokenFile = path.join(projectDir(project), `${sessionId}.json`);
  if (fs.existsSync(tokenFile)) {
    fs.rmSync(tokenFile, { force: true });
    log(`down: session ${sessionId} on "${project}"`);
  }
  reconcile();
}

function status() {
  gcTokens();
  const tokens = listTokens();
  console.log(`machine sessions dir: ${SESSIONS_DIR}`);
  console.log(`active sessions (${tokens.length}):`);
  for (const t of tokens) {
    console.log(
      `  • ${t.project.padEnd(18)} session=${t.sessionId} harness=${t.harness} pid=${t.pid}${isAlive(t.pid) ? "" : " (dead)"}`,
    );
  }
  const leafPid = readPid(LEAF_PID);
  console.log(`\nleaf node: ${isAlive(leafPid) ? `running (pid ${leafPid})` : "stopped"}`);
  for (const f of fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR) : []) {
    if (f.endsWith(".daemon.pid")) {
      const p = f.replace(".daemon.pid", "");
      const pid = readPid(path.join(SESSIONS_DIR, f));
      console.log(`daemon ${p}: ${isAlive(pid) ? `running (pid ${pid})` : "stopped"}`);
    }
  }
}

// --------------------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const stdin = cmd === "up" || cmd === "down" ? readStdinJson() : {};
try {
  switch (cmd) {
    case "up": up(flags, stdin); break;
    case "down": down(flags, stdin); break;
    case "gc": reconcile(); break;
    case "status": status(); break;
    default:
      console.log("usage: session.js <up|down|gc|status> [--root DIR] [--session ID] [--harness NAME] [--pid PID]");
  }
} catch (err) {
  // NEVER fail a harness hook — log and exit 0.
  log(`error in "${cmd}": ${err.stack || err.message}`);
}
process.exit(0);
