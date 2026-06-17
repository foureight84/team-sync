#!/bin/sh
# Install (or remove) the team-sync git hooks.
#
#   sh tooling/git-hooks/install.sh             # install
#   sh tooling/git-hooks/install.sh --uninstall # remove
#
# Each installed hook is a thin stub that execs the tracked script in
# tooling/git-hooks/, so updates to the tracked hooks take effect immediately
# without reinstalling.
set -e

HOOKS="post-commit post-merge post-rewrite post-checkout"

GIT_DIR="$(git rev-parse --git-dir 2>/dev/null)" || {
  echo "error: not inside a git repository — run 'git init' first." >&2
  exit 1
}
HOOK_DIR="$GIT_DIR/hooks"
mkdir -p "$HOOK_DIR"

if [ "$1" = "--uninstall" ]; then
  for h in $HOOKS; do
    if grep -q "team-sync git hook stub" "$HOOK_DIR/$h" 2>/dev/null; then
      rm -f "$HOOK_DIR/$h"
      echo "removed $HOOK_DIR/$h"
    fi
  done
  echo "team-sync hooks uninstalled."
  exit 0
fi

for h in $HOOKS; do
  dest="$HOOK_DIR/$h"
  if [ -e "$dest" ] && ! grep -q "team-sync git hook stub" "$dest" 2>/dev/null; then
    echo "warning: $dest exists and is not ours — skipping (back it up and re-run)." >&2
    continue
  fi
  cat > "$dest" <<'STUB'
#!/bin/sh
# team-sync git hook stub — delegates to the tracked tooling/git-hooks/ script.
root="$(git rev-parse --show-toplevel)"
hook="$(basename "$0")"
exec "$root/tooling/git-hooks/$hook" "$@"
STUB
  chmod +x "$dest"
  echo "installed $dest"
done

echo "team-sync hooks installed. They run 'graphify update .' after commit/pull/rebase/branch-switch."
