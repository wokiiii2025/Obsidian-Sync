import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.admin import pg_dump, prune_local_backups


def test_prune_local_backups_keeps_newest_files(tmp_path: Path) -> None:
    files = [tmp_path / f"backup-{index}.dump" for index in range(4)]
    for index, file in enumerate(files):
        file.write_text(str(index), encoding="utf-8")
        timestamp = time.time() + index
        os.utime(file, (timestamp, timestamp))

    prune_local_backups(tmp_path, keep=2)

    assert sorted(file.name for file in tmp_path.glob("*.dump")) == ["backup-2.dump", "backup-3.dump"]


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
