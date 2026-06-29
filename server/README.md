# Obsidian Sync Server

Phase 1 implements the sync server described in `../Docs/obsidian-sync-design.md`.

## What is included

- FastAPI service under `sync-api/`
- PostgreSQL schema in `init.sql`
- Docker Compose deployment with PostgreSQL, API, and Nginx
- JWT authentication for Obsidian clients
- API-key protected Hermes merge queue endpoint
- Incremental sync log and version-vector conflict detection
- Telegram intake service that receives Bot webhooks and queues messages for Hermes
- Token-protected web admin panel with database statistics, Hermes queue visibility, and backups

The server stores encrypted note payloads only. Clients are responsible for deriving keys and encrypting paths, content, and DEKs before upload.

## Run locally

1. Copy `.env.example` to `.env`.
2. Replace every value with a strong secret.
3. Start the stack:

```bash
docker compose up --build -d
```

4. Check health:

```bash
curl http://127.0.0.1:8080/health
```

## API

Base URL: `/api/v1`

- `POST /auth/register`
- `POST /auth/login`
- `GET /sync/changes?since=<ISO timestamp>&limit=100`
- `POST /sync/push`
- `POST /sync/resolve`
- `POST /hermes/merge`
- `GET /hermes/queue?status=pending&limit=20`
- `POST /hermes/queue/{item_id}/complete`

## Web admin panel

The Sync API serves a lightweight admin panel at:

```text
GET /admin
```

Required environment:

```bash
ADMIN_TOKEN=<strong-random-token>
```

Open `/admin`, enter the admin token, and the panel can show:

- vault, device, active file, deleted file, version, and sync-log counts;
- Hermes queue counts and recent queue items;
- local backup configuration and recent backup files;
- a manual `Run backup now` action.

The token is sent as the `X-Admin-Token` header for admin API requests. If `ADMIN_TOKEN` is empty, the admin API returns `503` so the panel cannot expose server data accidentally.

## Database backups

Backups run inside the `sync-api` container by using `pg_dump` against `DATABASE_URL`. The Docker image includes `postgresql-client` and `rclone`.

Default environment:

```bash
ADMIN_BACKUP_ENABLED=false
ADMIN_BACKUP_INTERVAL_HOURS=24
ADMIN_BACKUP_DIRECTORY=/app/backups
ADMIN_BACKUP_KEEP_LOCAL=14
ADMIN_BACKUP_TIMEOUT_SECONDS=600
```

Compose mounts local backup files to:

```text
server/backups/
```

The backup file format is PostgreSQL custom dump (`*.dump`). To restore one manually:

```bash
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" backups/obsidian-sync-YYYYMMDD-HHMMSS.dump
```

Manual backups are always available from the admin panel. `ADMIN_BACKUP_ENABLED=true` only controls the background scheduled backup loop. Leave it as `false` if backups should run only when an administrator clicks the button.

### Google Drive backup

Google Drive backup is supported through `rclone`. This still uses normal Google account login and OAuth authorization, but the credential is stored in the mounted rclone config file instead of the application database. When `ADMIN_BACKUP_RCLONE_REMOTE` is configured, every successful manual backup, and any scheduled backup if enabled, is copied to the configured Google Drive folder.

Create the mounted config directory on the server:

```bash
mkdir -p /home/obsidian-server/rclone
```

Run rclone config interactively and create a remote named `gdrive`:

```bash
docker run --rm -it \
  -v /home/obsidian-server/rclone:/config/rclone \
  rclone/rclone config
```

Then set:

```bash
ADMIN_BACKUP_RCLONE_REMOTE=gdrive:obsidian-sync-backups
```

Restart the API service:

```bash
docker compose -f docker-compose.prod.yml up -d sync-api
```

When `ADMIN_BACKUP_RCLONE_REMOTE` is configured, every successful local database backup is copied to the configured Google Drive folder.

## Telegram Bot intake

The `telegram-bot/` service receives Telegram Bot webhooks, normalizes text, links, captions, and attachment metadata into Markdown, then queues the item through `POST /api/v1/hermes/merge`.

Required environment:

```bash
TELEGRAM_BOT_TOKEN=<bot-token-from-botfather>
TELEGRAM_WEBHOOK_SECRET=<random-secret-path-token>
TELEGRAM_VAULT_ID=<vault-uuid>
HERMES_API_KEY=<same-key-used-by-sync-api>
```

Optional environment:

```bash
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890,-1009876543210
TELEGRAM_TARGET_NOTE_PATH=Inbox/Telegram.md
TELEGRAM_REPLY_ON_QUEUE=true
TELEGRAM_DELETE_AFTER_QUEUE=false
TELEGRAM_POLLING_ENABLED=true
TELEGRAM_SKIP_PENDING_ON_START=true
```

## Server-side Hermes Agent

For fully automatic processing without keeping Obsidian open, enable the server-side Hermes Agent in the Sync API service. This gives the server-side agent vault encryption access, so it changes the security model from strict zero-knowledge to an explicitly authorized server agent.

```bash
HERMES_AGENT_ENABLED=true
HERMES_AGENT_VAULT_ID=<vault-uuid>
HERMES_AGENT_VAULT_PASSWORD=<vault-password>
HERMES_AGENT_INTERVAL_SECONDS=60
HERMES_AGENT_CREATE_FOLDER=Inbox/Hermes
HERMES_AGENT_INBOX_PATH=Inbox/Telegram.md
HERMES_AGENT_APPEND_SCORE_THRESHOLD=6
```

When enabled, the agent:

- consumes pending Hermes queue items automatically;
- decrypts the vault index using the configured vault password;
- routes content by keyword rules and existing-note similarity;
- appends to matching Markdown notes or creates new notes;
- encrypts the result using the same client-compatible format;
- writes note versions and sync logs so other devices download the change.

Recommended first-run mode is polling. It does not require an HTTPS domain; the server actively pulls updates from Telegram.

Webhook endpoint:

```text
POST /telegram/webhook/<TELEGRAM_WEBHOOK_SECRET>
```

Set the Telegram webhook after exposing the bot service over HTTPS:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://<domain>/telegram/webhook/$TELEGRAM_WEBHOOK_SECRET" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

If polling is enabled, the service deletes any existing webhook on startup and reads new updates with `getUpdates`.

Current behavior:

- Allowed chat filtering is controlled by `TELEGRAM_ALLOWED_CHAT_IDS`.
- Messages are queued into the Hermes queue target note, defaulting to `Inbox/Telegram.md`.
- If the server-side Hermes Agent is enabled, it automatically routes, merges, encrypts, and syncs queued items without Obsidian being open.
- If the server-side Hermes Agent is disabled, the Obsidian plugin can run the local Hermes Agent automation while Obsidian is open and unlocked.
- Bot can reply with the queue id after successful intake.
- Bot can delete the original Telegram message after successful intake if enabled.
- Actual AI extraction is intentionally left for a later Hermes worker stage.

Binary encrypted fields are encoded as base64 in JSON:

- `encrypted_path`
- `encrypted_content`
- `encrypted_dek`

## Deployment note

The supplied `nginx.conf` proxies HTTP. For production, terminate TLS at Nginx or another reverse proxy before exposing the service publicly.
