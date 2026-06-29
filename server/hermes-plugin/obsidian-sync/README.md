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
It uses `terminal.exec` plus `bin/obsidian-sync-tool` for execution because this is compatible with the existing server Hermes provider.

Install the systemd units:

```bash
cp systemd/obsidian-hermes-queue.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now obsidian-hermes-queue.timer
```

Hermes must have a working inference provider before enabling the timer.
