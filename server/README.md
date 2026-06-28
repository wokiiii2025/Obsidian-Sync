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
- The Obsidian plugin can refresh the queue, import pending items into local Markdown, and mark them as merged.
- Bot can reply with the queue id after successful intake.
- Bot can delete the original Telegram message after successful intake if enabled.
- Actual AI extraction is intentionally left for a later Hermes worker stage.

Binary encrypted fields are encoded as base64 in JSON:

- `encrypted_path`
- `encrypted_content`
- `encrypted_dek`

## Deployment note

The supplied `nginx.conf` proxies HTTP. For production, terminate TLS at Nginx or another reverse proxy before exposing the service publicly.
