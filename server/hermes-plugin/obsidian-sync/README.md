# Obsidian Sync Hermes Plugin

This Hermes plugin exposes Obsidian Sync API operations as callable tools.

Environment:

```bash
OBSIDIAN_SYNC_API_URL=http://127.0.0.1:46990
HERMES_API_KEY=<same value used by sync-api>
```

Tools:

- `obsidian_sync_queue_next`
- `obsidian_sync_search_notes`
- `obsidian_sync_read_note`
- `obsidian_sync_create_note`
- `obsidian_sync_update_note`
- `obsidian_sync_append_note`
- `obsidian_sync_complete_queue`
- `obsidian_sync_fail_queue`

## Queue worker

`bin/process-queue.sh` runs Hermes in one-shot mode and asks it to process one pending queue item through the tools.
The worker script executes the Obsidian Sync API calls itself and uses the configured server Hermes model to decide the target note and Markdown content.
This avoids depending on one-shot CLI tool-call execution while still using the server's active Hermes provider for analysis.

The helper accepts both argument-style calls and JSON stdin:

```bash
obsidian-sync-tool queue-next
obsidian-sync-tool search "github project"
obsidian-sync-tool read "Git开源项目/example.md"
obsidian-sync-tool append "Git开源项目/example.md" "New analyzed content"
printf '{"path":"Git开源项目/example.md","content":"New analyzed content"}' | obsidian-sync-tool update
obsidian-sync-tool complete 123
```

Install the systemd units:

```bash
cp systemd/obsidian-hermes-queue.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now obsidian-hermes-queue.timer
```

Hermes must have a working inference provider before enabling the timer.
