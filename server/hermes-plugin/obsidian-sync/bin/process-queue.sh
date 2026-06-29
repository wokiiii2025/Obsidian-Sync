#!/usr/bin/env bash
set -euo pipefail

if [ -f /root/.hermes/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /root/.hermes/.env
  set +a
fi

exec hermes -t obsidian_sync -z "$(
  cat <<'PROMPT'
Process one pending Obsidian Sync Hermes queue item.

Rules:
1. Call obsidian_queue_next first.
2. If there is no item, reply "no pending item" and stop.
3. If there is an item, inspect merge_content and source_type.
4. Search related notes with obsidian_search_notes.
5. Read the most relevant note when deciding whether to append.
6. Prefer appending to a clearly relevant existing note. Create a new note only when no existing note is a good fit.
7. For GitHub repository links, create or update a concise project note under the existing Git open-source project area when appropriate.
8. After a successful write, call obsidian_complete_queue with the item id.
9. If you cannot safely process the item, call obsidian_fail_queue with a short reason.
10. Keep the final reply short and include the target path.
PROMPT
)"
