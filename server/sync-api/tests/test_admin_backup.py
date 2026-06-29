import os
import time
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.admin import create_backup_archive, pg_dump, prune_google_drive_backups, prune_local_backups
from app.admin import google_drive_status, sign_google_state, verify_google_state


def test_prune_local_backups_keeps_newest_files(tmp_path: Path) -> None:
    files = [tmp_path / f"backup-{index}.zip" for index in range(4)]
    for index, file in enumerate(files):
        file.write_text(str(index), encoding="utf-8")
        timestamp = time.time() + index
        os.utime(file, (timestamp, timestamp))

    prune_local_backups(tmp_path, keep=2)

    assert sorted(file.name for file in tmp_path.glob("*.zip")) == ["backup-2.zip", "backup-3.zip"]


def test_create_backup_archive_contains_restore_assets(tmp_path: Path) -> None:
    dump_path = tmp_path / "database.dump"
    archive_path = tmp_path / "backup.zip"
    dump_path.write_bytes(b"pg-dump")

    create_backup_archive(dump_path, archive_path, datetime(2026, 6, 29, tzinfo=UTC))

    with zipfile.ZipFile(archive_path) as archive:
        assert sorted(archive.namelist()) == ["README-restore.md", "database.dump", "manifest.json"]
        assert archive.read("database.dump") == b"pg-dump"
        assert "pg_restore" in archive.read("README-restore.md").decode("utf-8")


def test_google_state_roundtrip() -> None:
    settings = SimpleNamespace(admin_token="admin-secret", jwt_secret="jwt-secret")
    state = sign_google_state(settings)

    assert verify_google_state(settings, state)
    assert not verify_google_state(SimpleNamespace(admin_token="other", jwt_secret="jwt-secret"), state)


def test_google_drive_status_reflects_token_file(tmp_path: Path) -> None:
    token_file = tmp_path / "google-token.json"
    token_file.write_text('{"refresh_token":"x"}', encoding="utf-8")
    settings = SimpleNamespace(
        admin_google_token_file=str(token_file),
        admin_google_client_id="client",
        admin_google_client_secret="secret",
        admin_google_drive_folder_id="",
        admin_google_drive_folder_name="Backups",
        admin_google_redirect_uri="https://example.com/admin/google/callback",
        admin_public_url="",
    )

    status = google_drive_status(settings)

    assert status["configured"] is True
    assert status["connected"] is True
    assert status["folder_name"] == "Backups"
    assert status["redirect_uri"] == "https://example.com/admin/google/callback"


@pytest.mark.anyio
async def test_pg_dump_uses_decoded_database_url(monkeypatch, tmp_path: Path) -> None:
    captured = {}

    async def fake_run_command(command, env=None, timeout=600):
        captured["command"] = command
        captured["env"] = env
        captured["timeout"] = timeout

    monkeypatch.setattr("app.admin.run_command", fake_run_command)
    settings = SimpleNamespace(
        database_url="postgresql+asyncpg://sync%20user:p%40ss%2Fword@db.example.com:15432/obsidian_sync",
        admin_backup_timeout_seconds=123,
    )

    await pg_dump(settings, tmp_path / "test.dump")

    assert captured["command"][:2] == ["pg_dump", "--format=custom"]
    assert captured["command"][captured["command"].index("--username") + 1] == "sync user"
    assert captured["command"][captured["command"].index("--host") + 1] == "db.example.com"
    assert captured["command"][captured["command"].index("--port") + 1] == "15432"
    assert captured["command"][-1] == "obsidian_sync"
    assert captured["env"]["PGPASSWORD"] == "p@ss/word"
    assert captured["timeout"] == 123


@pytest.mark.anyio
async def test_prune_google_drive_backups_deletes_old_files(monkeypatch) -> None:
    deleted = []

    class FakeResponse:
        def __init__(self, payload=None):
            self.payload = payload or {}

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    class FakeClient:
        def __init__(self, timeout=30):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, *args, **kwargs):
            return FakeResponse(
                {
                    "files": [
                        {"id": "1", "name": "obsidian-sync-1.zip"},
                        {"id": "2", "name": "obsidian-sync-2.zip"},
                        {"id": "3", "name": "obsidian-sync-3.zip"},
                        {"id": "4", "name": "obsidian-sync-4.zip"},
                    ]
                }
            )

        async def delete(self, url, **kwargs):
            deleted.append(url)
            return FakeResponse()

    monkeypatch.setattr("app.admin.httpx.AsyncClient", FakeClient)
    settings = SimpleNamespace(admin_backup_keep_local=3)

    await prune_google_drive_backups(settings, "access-token", "folder-id")

    assert deleted == ["https://www.googleapis.com/drive/v3/files/4"]
