#!/bin/sh
# One-time, per-machine setup for team-sync.
#
#   sh tooling/setup/install-machine.sh      (or: npm run setup:machine)
#
# Installs the supervisor (pm2), brings up the single shared NATS leaf node,
# and wires it to start on boot. Idempotent — safe to re-run.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MACHINE_DIR="${TEAM_SYNC_HOME:-$HOME/.team-sync}"

echo "team-sync machine install"
echo "  repo:    $REPO_ROOT"
echo "  machine: $MACHINE_DIR"
echo

# --- 1. prerequisites -------------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "error: node not found (need >=20)." >&2; exit 1; }

if ! command -v nats-server >/dev/null 2>&1; then
  echo "warning: nats-server not on PATH." >&2
  echo "  Install it before the leaf node can start:" >&2
  echo "    macOS:  brew install nats-server" >&2
  echo "    Linux:  see https://docs.nats.io/.../installation" >&2
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "installing pm2 globally…"
  npm install -g pm2
fi

# --- 2. machine state -------------------------------------------------------
mkdir -p "$MACHINE_DIR/apps" "$MACHINE_DIR/leaf-store"

if [ ! -f "$MACHINE_DIR/identity" ]; then
  printf '%s\n' "$(hostname | tr -cd 'A-Za-z0-9-')" > "$MACHINE_DIR/identity"
  echo "wrote agent identity: $(cat "$MACHINE_DIR/identity")  (edit $MACHINE_DIR/identity to change)"
fi

if [ ! -f "$MACHINE_DIR/registry.json" ]; then
  printf '{\n  "projects": []\n}\n' > "$MACHINE_DIR/registry.json"
fi

# --- 3. generate leaf config + start it under pm2 ---------------------------
node "$REPO_ROOT/tooling/setup/manage.js" gen-leaf

if command -v nats-server >/dev/null 2>&1; then
  pm2 start "$MACHINE_DIR/apps/leaf.config.cjs" || pm2 restart team-sync-leaf
  pm2 save
  echo
  echo "✓ leaf node running on 127.0.0.1:4222 (pm2: team-sync-leaf)"
  echo
  echo "To make everything start on boot, run the command pm2 prints below:"
  pm2 startup || true
else
  echo
  echo "leaf node NOT started — install nats-server, then re-run this script."
fi

echo
echo "Next: cd into a project that has team-sync.json and run  npm run enroll"
