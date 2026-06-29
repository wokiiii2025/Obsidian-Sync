#!/usr/bin/env bash
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES_BIN="${HERMES_BIN:-$HERMES_HOME/hermes-agent/venv/bin/hermes}"

if [ -f "$HERMES_HOME/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERMES_HOME/.env"
  set +a
fi

exec "$HERMES_BIN" -t hermes-cli,obsidian_sync -z "$(
  cat <<'PROMPT'
Process one pending Obsidian Sync Hermes queue item.

Rules:
1. Call obsidian_sync_queue_next first.
2. If there is no item, reply "no pending item" and stop.
3. If there is an item, inspect merge_content and source_type.
4. Search related notes with obsidian_sync_search_notes.
5. Read the most relevant note when deciding whether to append.
6. Prefer appending to a clearly relevant existing note. Create a new note only when no existing note is a good fit.
7. For GitHub repository links, create or update a concise project note under the existing Git open-source project area when appropriate.
8. After a successful write, call obsidian_sync_complete_queue with the item id.
9. If you cannot safely process the item, call obsidian_sync_fail_queue with a short reason.
10. Keep the final reply short and include the target path.
PROMPT
)"
