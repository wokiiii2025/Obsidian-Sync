import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, text

from app.config import Settings
from app.models import Note, NoteVersion, SyncLog

logger = logging.getLogger("obsidian-sync-api")


async def prune_expired_data(
    session_factory,
    retention_days: int = 30,
    keep_versions: int = 50,
    prune_sync_log: bool = True,
) -> dict:
    """回收过期数据，避免 notes/note_versions/sync_log 无限增长。

    - 软删除笔记(墓碑)：超过 retention_days 后硬删除，并清理其版本记录与孤立日志。
    - 版本历史：每个笔记只保留最新 keep_versions 条。
    - 同步日志：仅清理超过 retention_days 的条目(长时间未同步的设备需做全量重同步)。
    """
    cutoff = datetime.now(UTC) - timedelta(days=retention_days)

    async with session_factory() as session:
        # 1) 硬删除超期软删除的笔记(墓碑回收)；note_versions 由外键级联删除。
        expired_ids = (
            await session.execute(
                select(Note.id).where(Note.deleted_at.is_not(None), Note.deleted_at < cutoff)
            )
        ).scalars().all()
        if expired_ids:
            await session.execute(delete(Note).where(Note.id.in_(expired_ids)))

        # 2) 回收过量版本历史：每个笔记只保留最新 keep_versions 条。
        version_result = await session.execute(
            text(
                """
                DELETE FROM note_versions
                WHERE id IN (
                    SELECT id FROM (
                        SELECT id,
                               row_number() OVER (
                                   PARTITION BY note_id
                                   ORDER BY created_at DESC, id DESC
                               ) AS rn
                        FROM note_versions
                    ) ranked
                    WHERE ranked.rn > :keep
                )
                """
            ),
            {"keep": max(1, keep_versions)},
        )

        # 3) 清理过期同步日志(可选，默认开启)。
        log_result = None
        if prune_sync_log:
            log_result = await session.execute(delete(SyncLog).where(SyncLog.synced_at < cutoff))

        await session.commit()

    return {
        "purged_soft_deleted_notes": len(expired_ids),
        "purged_note_versions": version_result.rowcount or 0,
        "purged_sync_logs": (log_result.rowcount if log_result is not None else 0) or 0,
    }


async def run_maintenance_loop(settings: Settings, session_factory) -> None:
    interval = max(1, settings.maintenance_interval_hours)
    while True:
        await asyncio.sleep(interval * 3600)
        try:
            result = await prune_expired_data(
                session_factory,
                retention_days=settings.maintenance_retention_days,
                keep_versions=settings.maintenance_keep_versions,
                prune_sync_log=settings.maintenance_prune_sync_log,
            )
            logger.info("maintenance prune: %s", result)
        except Exception as exc:  # noqa: BLE001
            logger.exception("maintenance prune failed: %s", exc)
