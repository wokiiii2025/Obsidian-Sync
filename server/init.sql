CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS vaults (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    device_name TEXT,
    platform TEXT,
    last_seen TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    path_hash TEXT NOT NULL,
    path_encrypted BYTEA NOT NULL,
    content_encrypted BYTEA NOT NULL,
    dek_encrypted BYTEA NOT NULL,
    version_vector JSONB NOT NULL DEFAULT '{}',
    file_size INT,
    mime_type TEXT DEFAULT 'text/markdown',
    modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE(vault_id, path_hash)
);

CREATE INDEX IF NOT EXISTS idx_notes_vault_modified ON notes(vault_id, modified_at);
CREATE INDEX IF NOT EXISTS idx_notes_vault_path ON notes(vault_id, path_hash);

CREATE TABLE IF NOT EXISTS note_versions (
    id BIGSERIAL PRIMARY KEY,
    vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    device_id UUID,
    operation TEXT NOT NULL,
    path_hash TEXT NOT NULL,
    path_encrypted BYTEA NOT NULL,
    content_encrypted BYTEA,
    dek_encrypted BYTEA,
    version_vector JSONB NOT NULL DEFAULT '{}',
    file_size INT,
    mime_type TEXT DEFAULT 'text/markdown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_note_versions_note_time ON note_versions(note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_versions_vault_time ON note_versions(vault_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sync_log (
    id BIGSERIAL PRIMARY KEY,
    vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    note_id UUID REFERENCES notes(id) ON DELETE SET NULL,
    device_id UUID,
    operation TEXT NOT NULL,
    path_hash TEXT,
    version_vector JSONB,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_log_vault_time ON sync_log(vault_id, synced_at);

CREATE TABLE IF NOT EXISTS hermes_queue (
    id BIGSERIAL PRIMARY KEY,
    vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    target_note_path TEXT,
    merge_content TEXT,
    source_url TEXT,
    source_type TEXT,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    merged_at TIMESTAMPTZ
);
