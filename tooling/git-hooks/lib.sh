#!/bin/sh
# Shared helper for team-sync git hooks.
#
# Graphify's graph.json is local and per-machine, so any git operation that
# mutates the working tree leaves the graph stale. These hooks re-extract it.

graphify_refresh() {
  hook="$1"

  if ! command -v graphify >/dev/null 2>&1; then
    echo "[graphify-hook:$hook] graphify not on PATH — skipping graph refresh" >&2
    return 0
  fi

  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  echo "[graphify-hook:$hook] refreshing local graph (graphify update .)…"

  # Run synchronously so the graph is fresh before the next agent query.
  # Append '&' below if you prefer commits/pulls to return immediately.
  if ! ( cd "$root" && graphify update . ); then
    echo "[graphify-hook:$hook] graphify update failed — local graph may be stale" >&2
  fi
}
