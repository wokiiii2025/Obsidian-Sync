# Obsidian Sync Server

Phase 1 implements the sync server described in `../Docs/obsidian-sync-design.md`.

## What is included

- FastAPI service under `sync-api/`
- PostgreSQL schema in `init.sql`
- Docker Compose deployment with PostgreSQL, API, and Nginx
- JWT authentication for Obsidian clients
- API-key protected Hermes merge queue endpoint
- Incremental sync log and version-vector conflict detection

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

Binary encrypted fields are encoded as base64 in JSON:

- `encrypted_path`
- `encrypted_content`
- `encrypted_dek`

## Deployment note

The supplied `nginx.conf` proxies HTTP. For production, terminate TLS at Nginx or another reverse proxy before exposing the service publicly.
