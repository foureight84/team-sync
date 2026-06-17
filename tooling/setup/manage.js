#!/usr/bin/env node
/**
 * team-sync machine manager.
 *
 *   node tooling/setup/manage.js enroll [projectDir]   enroll a project & start its daemon
 *   node tooling/setup/manage.js leave  [projectDir|id] stop & unenroll a project
 *   node tooling/setup/manage.js gen-leaf                regenerate the leaf config from the registry
 *   node tooling/setup/manage.js list                    show registry + pm2 status
 *
 * Source of truth is ~/.team-sync/registry.json. pm2 apps are driven by
 * generated ecosystem files under ~/.team-sync/apps/ so the same code path
 * works on macOS, Linux, and Windows.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { loadProjectManifest } from "../config.js";
import {
  MACHINE_DIR,
  APPS_DIR,
  LEAF_CONF,
  LEAF_PORT,
  LEAF_APP,
  projectToken,
  ensureMachineDirs,
  hubHost,
  writeLeafConf,
  readRegistry,
  writeRegistry,
} from "./machine.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function pm2(args, { optional = false } = {}) {
  try {
    return execFileSync("pm2", args, { stdio: "inherit" });
  } catch (err) {
    if (optional) return null;
    throw new Error(
      `pm2 ${args.join(" ")} failed. Is pm2 installed? (npm i -g pm2)\n${err.message}`,
    );
  }
}

// One leaf node, one remote per distinct enrolled hub (from the registry).
function genLeafConfig() {
  const reg = readRegistry();
  const hubs = writeLeafConf(reg.projects.map((p) => p.hub));
  console.log(
    `wrote ${LEAF_CONF} (${hubs.length} hub remote${hubs.length === 1 ? "" : "s"})`,
  );
  return { hubs };
}

function writeLeafEcosystem() {
  ensureMachineDirs();
  const file = path.join(APPS_DIR, "leaf.config.cjs");
  const cfg = {
    apps: [
      {
        name: LEAF_APP,
        script: "nats-server",
        args: `-c ${LEAF_CONF}`,
        interpreter: "none",
        autorestart: true,
        max_restarts: 50,
      },
    ],
  };
  fs.writeFileSync(file, `module.exports = ${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

function writeDaemonEcosystem(entry) {
  ensureMachineDirs();
  const file = path.join(APPS_DIR, `${entry.project}.config.cjs`);
  const cfg = {
    apps: [
      {
        name: `team-sync-daemon-${entry.project}`,
        script: path.join(REPO_ROOT, "tooling", "sync-daemon.js"),
        cwd: entry.path,
        autorestart: true,
        max_restarts: 50,
        env: {
          SYNC_PROJECT_ROOT: entry.path,
          NATS_URL: `nats://127.0.0.1:${LEAF_PORT}`,
          TEAM_SYNC_HOME: MACHINE_DIR,
        },
      },
    ],
  };
  fs.writeFileSync(file, `module.exports = ${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
function enroll(targetDir) {
  const root = path.resolve(targetDir || process.cwd());
  const manifest = loadProjectManifest(root);

  if (!manifest) {
    throw new Error(
      `no team-sync.json in ${root}.\n` +
        `This looks like a private project — create team-sync.json ` +
        `(see team-sync.example.json) to enroll it.`,
    );
  }
  if (manifest.broadcast !== true) {
    throw new Error(
      `team-sync.json in ${root} has broadcast:false — refusing to enroll a private project.`,
    );
  }
  if (!manifest.hub) {
    throw new Error(`team-sync.json in ${root} is missing "hub".`);
  }

  const project = projectToken(manifest.project || path.basename(root));
  const entry = { project, path: root, hub: manifest.hub };

  const reg = readRegistry();
  reg.projects = reg.projects.filter((p) => p.project !== project);
  reg.projects.push(entry);
  writeRegistry(reg);
  console.log(`enrolled "${project}" -> ${root} (hub ${hubHost(manifest.hub)})`);

  // Refresh the leaf so its remotes include this project's hub, then (re)start.
  genLeafConfig();
  const leafEco = writeLeafEcosystem();
  pm2(["start", leafEco]);
  pm2(["restart", LEAF_APP], { optional: true });

  // Start this project's dedicated daemon.
  const daemonEco = writeDaemonEcosystem(entry);
  pm2(["start", daemonEco]);
  pm2(["save"], { optional: true });

  console.log(`\n✓ ${project} is live. Events flow on subject team.sync.${project}.events.*`);
}

function leave(target) {
  const reg = readRegistry();
  const root = target ? path.resolve(target) : process.cwd();
  const id = projectToken(
    (loadProjectManifest(root) || {}).project || path.basename(root),
  );
  // Allow `leave <id>` as well as `leave <path>`.
  const match = reg.projects.find((p) => p.project === id || p.project === target);
  if (!match) {
    console.log(`no enrolled project matching "${target || root}".`);
    return;
  }

  pm2(["delete", `team-sync-daemon-${match.project}`], { optional: true });
  const eco = path.join(APPS_DIR, `${match.project}.config.cjs`);
  fs.rmSync(eco, { force: true });

  reg.projects = reg.projects.filter((p) => p.project !== match.project);
  writeRegistry(reg);
  genLeafConfig();
  pm2(["restart", LEAF_APP], { optional: true });
  pm2(["save"], { optional: true });
  console.log(`✓ unenrolled "${match.project}".`);
}

function list() {
  const reg = readRegistry();
  console.log(`machine dir: ${MACHINE_DIR}`);
  console.log(`enrolled projects (${reg.projects.length}):`);
  for (const p of reg.projects) {
    console.log(`  • ${p.project.padEnd(20)} ${p.path}  (hub ${hubHost(p.hub)})`);
  }
  console.log("\npm2 status:");
  pm2(["status"], { optional: true });
}

// ---------------------------------------------------------------------------
const [cmd, arg] = process.argv.slice(2);
try {
  switch (cmd) {
    case "enroll": enroll(arg); break;
    case "leave": leave(arg); break;
    case "gen-leaf": genLeafConfig(); writeLeafEcosystem(); break;
    case "list": list(); break;
    default:
      console.log(
        "usage: manage.js <enroll [dir] | leave [dir|id] | gen-leaf | list>",
      );
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
