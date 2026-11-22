"""服务端启动迁移与维护任务的集成测试。

需要真实 PostgreSQL，默认跳过；提供 TEST_DATABASE_URL 才会运行：

    TEST_DATABASE_URL=postgresql+asyncpg://user:pass@host:5432/scratch_db \
        python -m pytest tests/test_maintenance_integration.py -q

注意：测试会 DROP 该库里的所有表，务必指向一次性数据库。
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.maintenance import prune_expired_data
from app.models import Device, Note, NoteVersion, SyncLog, Vault

TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not TEST_DB_URL, reason="需要 TEST_DATABASE_URL 指向一次性 PostgreSQL 库"
)

MIGRATION_STATEMENTS = [
    "ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ",
    "ALTER TABLE devices ADD COLUMN IF NOT EXISTS client_instance_id TEXT",
    """
    CREATE INDEX IF NOT EXISTS idx_devices_vault_client_instance
    ON devices(vault_id, client_instance_id)
    WHERE client_instance_id IS NOT NULL AND revoked_at IS NULL
    """,
]


def _run(coro):
    return asyncio.run(coro)


async def _fresh_schema(engine) -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


def test_fresh_database_bootstrap() -> None:
    """空库：按启动顺序执行 create_all + 增量迁移，不应报错且最终结构齐全。"""

    async def scenario() -> None:
        engine = create_async_engine(TEST_DB_URL)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.drop_all)
            # 模拟 app.startup：全新库先 create_all，再执行 ALTER/索引
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
                for stmt in MIGRATION_STATEMENTS:
                    await conn.execute(text(stmt))
                tables = set(
                    (
                        await conn.execute(
                            text(
                                "select table_name from information_schema.tables "
                                "where table_schema='public'"
                            )
                        )
                    ).scalars()
                )
                columns = set(
                    (
                        await conn.execute(
                            text(
                                "select column_name from information_schema.columns "
                                "where table_name='devices'"
                            )
                        )
                    ).scalars()
                )
            assert {"vaults", "devices", "notes", "note_versions", "sync_log"} <= tables
            assert {"revoked_at", "client_instance_id"} <= columns
        finally:
            await engine.dispose()

    _run(scenario())


def test_maintenance_safe_defaults_keep_user_data() -> None:
    """默认参数下只回收墓碑：不动版本历史、不动同步日志、不自动吊销设备。"""

    async def scenario() -> dict:
        engine = create_async_engine(TEST_DB_URL)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            await _fresh_schema(engine)
            now = datetime.now(UTC)
            vault_id = uuid.uuid4()
            note_id = uuid.uuid4()
            async with session_factory() as session:
                session.add(Vault(id=vault_id, name="v", password_hash="x"))
                await session.flush()  # 先落库，避免子表外键顺序问题
                # 一台 90 天未活动的设备（默认不应被吊销）
                session.add(
                    Device(
                        id=uuid.uuid4(),
                        vault_id=vault_id,
                        device_name="idle",
                        platform="macOS",
                        last_seen=now - timedelta(days=90),
                    )
                )
                # 一台 hermes-agent（任何情况下都不自动吊销）
                session.add(
                    Device(
                        id=uuid.uuid4(),
                        vault_id=vault_id,
                        device_name="agent",
                        platform="hermes-agent",
                        last_seen=now - timedelta(days=365),
                    )
                )
                # 40 天前的墓碑：应被回收（其版本随外键级联删除）
                tomb_id = uuid.uuid4()
                session.add(
                    Note(
                        id=tomb_id,
                        vault_id=vault_id,
                        path_hash="h-tomb",
                        path_encrypted=b"p",
                        content_encrypted=b"c",
                        dek_encrypted=b"d",
                        version_vector={},
                        deleted_at=now - timedelta(days=40),
                    )
                )
                # 存活的笔记 + 60 条版本历史：默认不应裁剪
                session.add(
                    Note(
                        id=note_id,
                        vault_id=vault_id,
                        path_hash="h-live",
                        path_encrypted=b"p",
                        content_encrypted=b"c",
                        dek_encrypted=b"d",
                        version_vector={},
                    )
                )
                for _ in range(60):
                    session.add(
                        NoteVersion(
                            vault_id=vault_id,
                            note_id=note_id,
                            operation="update",
                            path_hash="h-live",
                            path_encrypted=b"p",
                            version_vector={},
                        )
                    )
                # 陈旧同步日志：默认不应清理
                session.add(
                    SyncLog(
                        vault_id=vault_id,
                        note_id=note_id,
                        operation="create",
                        path_hash="h",
                        synced_at=now - timedelta(days=400),
                    )
                )
                await session.commit()

            result = await prune_expired_data(session_factory)

            async with session_factory() as session:
                counts = {
                    "notes": (await session.execute(text("select count(*) from notes"))).scalar_one(),
                    "versions": (
                        await session.execute(text("select count(*) from note_versions"))
                    ).scalar_one(),
                    "sync_log": (
                        await session.execute(text("select count(*) from sync_log"))
                    ).scalar_one(),
                    "revoked": (
                        await session.execute(
                            text("select count(*) from devices where revoked_at is not null")
                        )
                    ).scalar_one(),
                }
            return {"result": result, "counts": counts}
        finally:
            await engine.dispose()

    out = _run(scenario())
    assert out["counts"]["notes"] == 1, "墓碑应被回收，仅剩存活笔记"
    assert out["counts"]["versions"] == 60, "默认不应裁剪版本历史"
    assert out["counts"]["sync_log"] == 1, "默认不应裁剪同步日志"
    assert out["counts"]["revoked"] == 0, "默认不应自动吊销设备"
    assert out["result"]["purged_soft_deleted_notes"] == 1


def test_maintenance_optin_actions() -> None:
    """显式开启后：裁剪版本、清理日志、吊销僵死设备，但跳过 hermes-agent。"""

    async def scenario() -> dict:
        engine = create_async_engine(TEST_DB_URL)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            await _fresh_schema(engine)
            now = datetime.now(UTC)
            vault_id = uuid.uuid4()
            note_id = uuid.uuid4()
            idle_id = uuid.uuid4()
            agent_id = uuid.uuid4()
            active_id = uuid.uuid4()
            async with session_factory() as session:
                session.add(Vault(id=vault_id, name="v", password_hash="x"))
                await session.flush()  # 先落库，避免子表外键顺序问题
                session.add_all(
                    [
                        Device(
                            id=idle_id,
                            vault_id=vault_id,
                            device_name="idle",
                            platform="macOS",
                            last_seen=now - timedelta(days=90),
                        ),
                        Device(
                            id=agent_id,
                            vault_id=vault_id,
                            device_name="agent",
                            platform="hermes-agent",
                            last_seen=now - timedelta(days=90),
                        ),
                        Device(
                            id=active_id,
                            vault_id=vault_id,
                            device_name="active",
                            platform="Android",
                            last_seen=now - timedelta(hours=1),
                        ),
                    ]
                )
                session.add(
                    Note(
                        id=note_id,
                        vault_id=vault_id,
                        path_hash="h",
                        path_encrypted=b"p",
                        content_encrypted=b"c",
                        dek_encrypted=b"d",
                        version_vector={},
                    )
                )
                for _ in range(10):
                    session.add(
                        NoteVersion(
                            vault_id=vault_id,
                            note_id=note_id,
                            operation="update",
                            path_hash="h",
                            path_encrypted=b"p",
                            version_vector={},
                        )
                    )
                session.add(
                    SyncLog(
                        vault_id=vault_id,
                        note_id=note_id,
                        operation="create",
                        path_hash="h",
                        synced_at=now - timedelta(days=400),
                    )
                )
                await session.commit()

            result = await prune_expired_data(
                session_factory,
                retention_days=30,
                keep_versions=3,
                prune_sync_log=True,
                revoke_inactive_days=30,
            )

            async with session_factory() as session:
                rows = (
                    await session.execute(text("select id, revoked_at from devices"))
                ).all()
                revoked = {str(r.id): r.revoked_at is not None for r in rows}
                versions = (
                    await session.execute(text("select count(*) from note_versions"))
                ).scalar_one()
                logs = (await session.execute(text("select count(*) from sync_log"))).scalar_one()
            return {
                "result": result,
                "revoked": revoked,
                "versions": versions,
                "logs": logs,
                "ids": {"idle": str(idle_id), "agent": str(agent_id), "active": str(active_id)},
            }
        finally:
            await engine.dispose()

    out = _run(scenario())
    assert out["versions"] == 3, "应裁剪到 keep_versions 条"
    assert out["logs"] == 0, "应清理过期同步日志"
    assert out["revoked"][out["ids"]["idle"]] is True, "僵死设备应被吊销"
    assert out["revoked"][out["ids"]["agent"]] is False, "hermes-agent 不应被自动吊销"
    assert out["revoked"][out["ids"]["active"]] is False, "活跃设备不应被吊销"
