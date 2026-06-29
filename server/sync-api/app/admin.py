import asyncio
import os
import shutil
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import HTMLResponse
from sqlalchemy import func, select, text

from app.config import Settings, get_settings
from app.database import SessionLocal
from app.models import Device, HermesQueue, Note, NoteVersion, SyncLog, Vault

router = APIRouter()


@dataclass
class BackupResult:
    ok: bool
    file: str
    size: int
    started_at: str
    finished_at: str
    uploaded: bool = False
    upload_target: str = ""
    error: str = ""


last_backup_result: BackupResult | None = None
backup_lock = asyncio.Lock()


def require_admin_token(
    x_admin_token: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    if not settings.admin_token:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Admin panel is not configured")
    if x_admin_token != settings.admin_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin token")


@router.get("/admin", response_class=HTMLResponse)
async def admin_page() -> str:
    return ADMIN_HTML


@router.get("/admin/api/status", dependencies=[Depends(require_admin_token)])
async def admin_status(settings: Settings = Depends(get_settings)) -> dict:
    async with SessionLocal() as session:
        vaults = await session.scalar(select(func.count()).select_from(Vault))
        devices = await session.scalar(select(func.count()).select_from(Device))
        active_notes = await session.scalar(select(func.count()).select_from(Note).where(Note.deleted_at.is_(None)))
        deleted_notes = await session.scalar(select(func.count()).select_from(Note).where(Note.deleted_at.is_not(None)))
        versions = await session.scalar(select(func.count()).select_from(NoteVersion))
        sync_logs = await session.scalar(select(func.count()).select_from(SyncLog))
        queue_rows = (await session.execute(select(HermesQueue.status, func.count()).group_by(HermesQueue.status))).all()
        db_now = await session.scalar(text("select now()"))
    return {
        "time": datetime.now(UTC).isoformat(),
        "database_time": db_now.isoformat() if db_now else "",
        "vaults": vaults or 0,
        "devices": devices or 0,
        "active_notes": active_notes or 0,
        "deleted_notes": deleted_notes or 0,
        "note_versions": versions or 0,
        "sync_logs": sync_logs or 0,
        "hermes_queue": {status: count for status, count in queue_rows},
        "hermes_agent_enabled": settings.hermes_agent_enabled,
        "backup": backup_config_snapshot(settings),
        "last_backup": asdict(last_backup_result) if last_backup_result else None,
    }


@router.get("/admin/api/hermes", dependencies=[Depends(require_admin_token)])
async def admin_hermes(limit: int = 20) -> dict:
    limit = max(1, min(limit, 100))
    async with SessionLocal() as session:
        query = select(HermesQueue).order_by(HermesQueue.id.desc()).limit(limit)
        items = (await session.execute(query)).scalars().all()
    return {
        "items": [
            {
                "id": item.id,
                "status": item.status,
                "source_type": item.source_type,
                "target_note_path": item.target_note_path,
                "created_at": item.created_at.isoformat() if item.created_at else "",
                "merged_at": item.merged_at.isoformat() if item.merged_at else "",
                "error_message": item.error_message,
                "preview": (item.merge_content or "").replace("\n", " ")[:180],
            }
            for item in items
        ]
    }


@router.get("/admin/api/backups", dependencies=[Depends(require_admin_token)])
async def list_backups(settings: Settings = Depends(get_settings)) -> dict:
    backup_dir = Path(settings.admin_backup_directory)
    files = []
    if backup_dir.exists():
        for file in sorted(backup_dir.glob("*.dump"), key=lambda item: item.stat().st_mtime, reverse=True):
            stat = file.stat()
            files.append({"name": file.name, "size": stat.st_size, "modified_at": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat()})
    return {"files": files, "last_backup": asdict(last_backup_result) if last_backup_result else None}


@router.post("/admin/api/backups/run", dependencies=[Depends(require_admin_token)])
async def run_backup_now(settings: Settings = Depends(get_settings)) -> dict:
    result = await run_backup(settings)
    return asdict(result)


async def run_backup_loop(settings: Settings) -> None:
    if not settings.admin_backup_enabled:
        return
    interval = max(1, settings.admin_backup_interval_hours) * 3600
    await asyncio.sleep(20)
    while True:
        await run_backup(settings)
        await asyncio.sleep(interval)


async def run_backup(settings: Settings) -> BackupResult:
    global last_backup_result
    async with backup_lock:
        started = datetime.now(UTC)
        backup_dir = Path(settings.admin_backup_directory)
        backup_dir.mkdir(parents=True, exist_ok=True)
        filename = f"obsidian-sync-{started.strftime('%Y%m%d-%H%M%S')}.dump"
        backup_path = backup_dir / filename
        try:
            await pg_dump(settings, backup_path)
            prune_local_backups(backup_dir, settings.admin_backup_keep_local)
            uploaded = False
            target = ""
            if settings.admin_backup_rclone_remote:
                target = settings.admin_backup_rclone_remote.rstrip("/")
                await rclone_copy(settings, backup_path, target)
                uploaded = True
            result = BackupResult(
                ok=True,
                file=str(backup_path),
                size=backup_path.stat().st_size,
                started_at=started.isoformat(),
                finished_at=datetime.now(UTC).isoformat(),
                uploaded=uploaded,
                upload_target=target,
            )
        except Exception as exc:
            result = BackupResult(
                ok=False,
                file=str(backup_path),
                size=backup_path.stat().st_size if backup_path.exists() else 0,
                started_at=started.isoformat(),
                finished_at=datetime.now(UTC).isoformat(),
                error=str(exc),
            )
        last_backup_result = result
        return result


async def pg_dump(settings: Settings, output_path: Path) -> None:
    parsed = urlparse(settings.database_url.replace("postgresql+asyncpg://", "postgresql://", 1))
    if parsed.scheme not in {"postgresql", "postgres"}:
        raise RuntimeError("Unsupported DATABASE_URL scheme for pg_dump")
    env = os.environ.copy()
    if parsed.password:
        env["PGPASSWORD"] = unquote(parsed.password)
    command = [
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--host",
        parsed.hostname or "localhost",
        "--port",
        str(parsed.port or 5432),
        "--username",
        unquote(parsed.username or "postgres"),
        "--file",
        str(output_path),
        parsed.path.lstrip("/"),
    ]
    await run_command(command, env=env, timeout=settings.admin_backup_timeout_seconds)


async def rclone_copy(settings: Settings, source: Path, target: str) -> None:
    command = ["rclone"]
    if settings.admin_backup_rclone_config:
        command.extend(["--config", settings.admin_backup_rclone_config])
    command.extend(["copy", str(source), target])
    await run_command(command, timeout=settings.admin_backup_timeout_seconds)


async def run_command(command: list[str], env: dict[str, str] | None = None, timeout: int = 600) -> None:
    executable = shutil.which(command[0])
    if executable is None:
        raise RuntimeError(f"Command not found: {command[0]}")
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        process.kill()
        await process.wait()
        raise RuntimeError(f"Command timed out: {command[0]}") from exc
    if process.returncode != 0:
        message = (stderr or stdout).decode("utf-8", "replace").strip()
        raise RuntimeError(message or f"Command failed: {command[0]}")


def prune_local_backups(backup_dir: Path, keep: int) -> None:
    if keep <= 0:
        return
    files = sorted(backup_dir.glob("*.dump"), key=lambda item: item.stat().st_mtime, reverse=True)
    for file in files[keep:]:
        file.unlink(missing_ok=True)


def backup_config_snapshot(settings: Settings) -> dict:
    return {
        "enabled": settings.admin_backup_enabled,
        "interval_hours": settings.admin_backup_interval_hours,
        "directory": settings.admin_backup_directory,
        "keep_local": settings.admin_backup_keep_local,
        "rclone_remote_configured": bool(settings.admin_backup_rclone_remote),
        "rclone_config": settings.admin_backup_rclone_config,
    }


ADMIN_HTML = """
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Obsidian Sync Admin</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #0f172a; color: #e5e7eb; }
    header { padding: 20px 28px; border-bottom: 1px solid #1f2937; display: flex; justify-content: space-between; align-items: center; }
    main { padding: 22px 28px 40px; max-width: 1180px; margin: 0 auto; }
    h1 { margin: 0; font-size: 20px; }
    h2 { font-size: 15px; margin: 0 0 14px; color: #f9fafb; }
    .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .card { background: #111827; border: 1px solid #243044; border-radius: 8px; padding: 16px; }
    .metric { font-size: 30px; font-weight: 700; margin: 4px 0; }
    .muted { color: #94a3b8; font-size: 13px; }
    input, button { border-radius: 6px; border: 1px solid #334155; background: #0b1220; color: #e5e7eb; padding: 8px 10px; }
    button { cursor: pointer; background: #2563eb; border-color: #2563eb; font-weight: 600; }
    button.secondary { background: #1f2937; border-color: #334155; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #1f2937; vertical-align: top; }
    th { color: #cbd5e1; }
    code { color: #bfdbfe; }
    .ok { color: #86efac; }
    .bad { color: #fca5a5; }
  </style>
</head>
<body>
  <header>
    <h1>Obsidian Sync Admin</h1>
    <div class="toolbar">
      <input id="token" type="password" placeholder="ADMIN_TOKEN" />
      <button class="secondary" onclick="saveToken()">保存令牌</button>
      <button onclick="refreshAll()">刷新</button>
    </div>
  </header>
  <main>
    <section class="grid" id="metrics"></section>
    <section class="grid" style="margin-top:14px">
      <div class="card">
        <h2>备份</h2>
        <div id="backupConfig" class="muted"></div>
        <div class="toolbar" style="margin-top:12px">
          <button onclick="runBackup()">立即备份</button>
          <button class="secondary" onclick="loadBackups()">刷新备份列表</button>
        </div>
        <div id="backupResult" class="muted" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <h2>Hermes 队列</h2>
        <div id="hermesSummary" class="muted"></div>
      </div>
    </section>
    <section class="card" style="margin-top:14px">
      <h2>最近备份</h2>
      <table><thead><tr><th>文件</th><th>大小</th><th>时间</th></tr></thead><tbody id="backups"></tbody></table>
    </section>
    <section class="card" style="margin-top:14px">
      <h2>最近 Hermes 队列</h2>
      <table><thead><tr><th>ID</th><th>状态</th><th>来源</th><th>时间</th><th>摘要</th></tr></thead><tbody id="hermes"></tbody></table>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById('token');
    tokenInput.value = localStorage.getItem('adminToken') || '';
    function saveToken(){ localStorage.setItem('adminToken', tokenInput.value); refreshAll(); }
    async function api(path, options = {}) {
      const res = await fetch(path, { ...options, headers: { 'X-Admin-Token': tokenInput.value, ...(options.headers || {}) } });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    }
    function size(bytes){ return `${(bytes / 1024 / 1024).toFixed(2)} MB`; }
    async function refreshAll(){ await Promise.allSettled([loadStatus(), loadBackups(), loadHermes()]); }
    async function loadStatus(){
      const data = await api('/admin/api/status');
      document.getElementById('metrics').innerHTML = [
        ['Vaults', data.vaults], ['设备', data.devices], ['活跃文件', data.active_notes], ['历史版本', data.note_versions], ['同步日志', data.sync_logs], ['已删除', data.deleted_notes]
      ].map(([name, value]) => `<div class="card"><div class="muted">${name}</div><div class="metric">${value}</div></div>`).join('');
      const b = data.backup;
      document.getElementById('backupConfig').innerHTML = `定时：<b class="${b.enabled ? 'ok' : 'bad'}">${b.enabled ? '开启' : '关闭'}</b>；间隔：${b.interval_hours}h；目录：<code>${b.directory}</code>；Google Drive/rclone：${b.rclone_remote_configured ? '<span class="ok">已配置</span>' : '<span class="bad">未配置</span>'}`;
      document.getElementById('backupResult').textContent = data.last_backup ? JSON.stringify(data.last_backup) : '暂无备份记录';
      document.getElementById('hermesSummary').textContent = JSON.stringify(data.hermes_queue);
    }
    async function loadBackups(){
      const data = await api('/admin/api/backups');
      document.getElementById('backups').innerHTML = data.files.map(file => `<tr><td><code>${file.name}</code></td><td>${size(file.size)}</td><td>${file.modified_at}</td></tr>`).join('');
    }
    async function loadHermes(){
      const data = await api('/admin/api/hermes');
      document.getElementById('hermes').innerHTML = data.items.map(item => `<tr><td>${item.id}</td><td>${item.status}</td><td>${item.source_type || ''}</td><td>${item.created_at}</td><td>${item.preview}</td></tr>`).join('');
    }
    async function runBackup(){
      document.getElementById('backupResult').textContent = '备份中...';
      const data = await api('/admin/api/backups/run', { method: 'POST' });
      document.getElementById('backupResult').innerHTML = data.ok ? `<span class="ok">成功</span> ${data.file} ${data.uploaded ? '已上传' : ''}` : `<span class="bad">失败</span> ${data.error}`;
      await loadBackups();
    }
    refreshAll().catch(err => { document.getElementById('metrics').innerHTML = `<div class="card bad">${err.message}</div>`; });
  </script>
</body>
</html>
"""
