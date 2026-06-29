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

set +e
"$HERMES_BIN" --yolo -t hermes-cli,obsidian_sync -z "$(
  cat <<'PROMPT'
Process one pending Obsidian Sync Hermes queue item.

Rules:
1. Use terminal.exec to run: /home/hermes/.hermes/plugins/obsidian-sync/bin/obsidian-sync-tool queue-next
2. If there is no item, reply "no pending item" and stop.
3. If there is an item, inspect merge_content and source_type.
4. Use terminal.exec with obsidian-sync-tool search/read to inspect relevant notes.
5. Use terminal.exec with obsidian-sync-tool append/create/update to write exactly one note.
6. Prefer appending to a clearly relevant existing note. Create a new note only when no existing note is a good fit.
7. For GitHub repository links, create or update a concise project note under the existing Git open-source project area when appropriate.
8. After a successful write, run: obsidian-sync-tool complete --item-id <id>
9. If you cannot safely process the item, run: obsidian-sync-tool fail with JSON {"item_id": <id>, "error": "..."} on stdin.
10. Keep the final reply short and include the target path.
PROMPT
)"
status=$?
if [ "$status" -eq 134 ]; then
  exit 0
fi
exit "$status"
