import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, text, update

from app.config import Settings
from app.models import Device, Note, NoteVersion, SyncLog

logger = logging.getLogger("obsidian-sync-api")


async def prune_expired_data(
    session_factory,
    retention_days: int = 30,
    keep_versions: int = 0,
    prune_sync_log: bool = False,
    revoke_inactive_days: int = 0,
) -> dict:
    """回收过期数据，避免 notes/note_versions/sync_log/devices 无限增长。

    安全默认：只回收「用户已删除」的墓碑笔记；其余动作必须显式开启。

    - 软删除笔记(墓碑)：超过 retention_days 后硬删除，版本记录由外键级联清理。
    - 版本历史：keep_versions > 0 时每个笔记只保留最新 N 条；0 = 不裁剪。
    - 同步日志：prune_sync_log=True 才清理超过 retention_days 的条目。
      注意：裁剪后长时间离线的设备会拿不到删除事件，需要客户端支持"日志缺口->全量重同步"，
      否则可能把已删笔记重新推回，故默认关闭。
    - 设备：revoke_inactive_days > 0 时吊销超过该天数未活动且非 hermes-agent 的设备；
      0 = 不自动吊销，避免误杀长期不用的备用设备。
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

        # 2) 回收过量版本历史(可选)：keep_versions > 0 才裁剪。
        version_result = None
        if keep_versions > 0:
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
                {"keep": keep_versions},
            )

        # 3) 清理过期同步日志(默认关闭，见 docstring)。
        log_result = None
        if prune_sync_log:
            log_result = await session.execute(delete(SyncLog).where(SyncLog.synced_at < cutoff))

        # 4) 吊销长期未活动的设备(默认关闭；排除 hermes-agent)。
        device_result = None
        if revoke_inactive_days > 0:
            device_cutoff = datetime.now(UTC) - timedelta(days=revoke_inactive_days)
            device_result = await session.execute(
                update(Device)
                .where(
                    Device.revoked_at.is_(None),
                    Device.platform != "hermes-agent",
                    (
                        (Device.last_seen.is_not(None) & (Device.last_seen < device_cutoff))
                        | (Device.last_seen.is_(None) & (Device.created_at < device_cutoff))
                    ),
                )
                .values(revoked_at=datetime.now(UTC))
            )

        await session.commit()

    return {
        "purged_soft_deleted_notes": len(expired_ids),
        "purged_note_versions": (version_result.rowcount or 0) if version_result is not None else 0,
        "purged_sync_logs": (log_result.rowcount or 0) if log_result is not None else 0,
        "revoked_inactive_devices": (device_result.rowcount or 0) if device_result is not None else 0,
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
                revoke_inactive_days=settings.maintenance_revoke_inactive_days,
            )
            logger.info("maintenance prune: %s", result)
        except Exception as exc:  # noqa: BLE001
            logger.exception("maintenance prune failed: %s", exc)
