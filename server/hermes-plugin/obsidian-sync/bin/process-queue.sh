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

python3 - "$HERMES_BIN" <<'PY'
import subprocess
import sys

prompt = """\
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
"""

process = subprocess.run(
    [sys.argv[1], "--yolo", "-t", "hermes-cli,obsidian_sync", "-z", prompt],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)
if process.stdout:
    print(process.stdout, end="")
if process.returncode in {0, 134, -6}:
    raise SystemExit(0)
raise SystemExit(process.returncode)
PY
