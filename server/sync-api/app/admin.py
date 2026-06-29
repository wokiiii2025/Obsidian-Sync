import asyncio
import base64
import hashlib
import hmac
import json
import os
import shutil
import zipfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode, unquote, urlparse

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import HTMLResponse
from sqlalchemy import func, select, text

from app.config import Settings, get_settings
from app.database import SessionLocal
from app.models import Device, HermesQueue, Note, NoteVersion, SyncLog, Vault

router = APIRouter()
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
GOOGLE_DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"
GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"


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
        "google_drive": google_drive_status(settings),
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
        for file in sorted(backup_dir.glob("*.zip"), key=lambda item: item.stat().st_mtime, reverse=True):
            stat = file.stat()
            files.append({"name": file.name, "size": stat.st_size, "modified_at": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat()})
    return {"files": files, "last_backup": asdict(last_backup_result) if last_backup_result else None}


@router.post("/admin/api/backups/run", dependencies=[Depends(require_admin_token)])
async def run_backup_now(settings: Settings = Depends(get_settings)) -> dict:
    result = await run_backup(settings)
    return asdict(result)


@router.get("/admin/api/google-drive/status", dependencies=[Depends(require_admin_token)])
async def admin_google_drive_status(settings: Settings = Depends(get_settings)) -> dict:
    return google_drive_status(settings)


@router.post("/admin/api/google-drive/auth-url", dependencies=[Depends(require_admin_token)])
async def admin_google_drive_auth_url(settings: Settings = Depends(get_settings)) -> dict:
    if not settings.admin_google_client_id or not settings.admin_google_client_secret:
        raise HTTPException(status_code=422, detail="Google OAuth client id or secret is not configured")
    redirect_uri = google_redirect_uri(settings)
    state = sign_google_state(settings)
    params = {
        "client_id": settings.admin_google_client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": GOOGLE_DRIVE_SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return {"auth_url": f"{GOOGLE_AUTH_URL}?{urlencode(params)}", "redirect_uri": redirect_uri}


@router.post("/admin/api/google-drive/disconnect", dependencies=[Depends(require_admin_token)])
async def admin_google_drive_disconnect(settings: Settings = Depends(get_settings)) -> dict:
    token_path = Path(settings.admin_google_token_file)
    token_path.unlink(missing_ok=True)
    return google_drive_status(settings)


@router.get("/admin/google/callback", response_class=HTMLResponse)
async def admin_google_drive_callback(code: str = "", state: str = "", error: str = "", settings: Settings = Depends(get_settings)) -> str:
    if error:
        return callback_html(False, f"Google authorization failed: {error}")
    if not code or not verify_google_state(settings, state):
        return callback_html(False, "Invalid or expired Google authorization state.")
    try:
        token = await exchange_google_code(settings, code)
        save_google_token(settings, token)
    except Exception as exc:
        return callback_html(False, f"Failed to save Google Drive credentials: {exc}")
    return callback_html(True, "Google Drive connected. You can close this page and return to the admin panel.")


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
        backup_name = f"obsidian-sync-{started.strftime('%Y%m%d-%H%M%S')}"
        dump_path = backup_dir / f"{backup_name}.dump"
        backup_path = backup_dir / f"{backup_name}.zip"
        try:
            await pg_dump(settings, dump_path)
            create_backup_archive(dump_path, backup_path, started)
            dump_path.unlink(missing_ok=True)
            prune_local_backups(backup_dir, settings.admin_backup_keep_local)
            uploaded = False
            target = ""
            if google_drive_status(settings)["connected"]:
                target = settings.admin_google_drive_folder_name
                await upload_to_google_drive(settings, backup_path)
                uploaded = True
            elif settings.admin_backup_rclone_remote:
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
            if backup_path.exists() and backup_path.stat().st_size == 0:
                backup_path.unlink(missing_ok=True)
            result = BackupResult(
                ok=False,
                file=str(backup_path),
                size=backup_path.stat().st_size if backup_path.exists() else 0,
                started_at=started.isoformat(),
                finished_at=datetime.now(UTC).isoformat(),
                error=str(exc),
            )
        finally:
            if "dump_path" in locals():
                dump_path.unlink(missing_ok=True)
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
    files = sorted(backup_dir.glob("*.zip"), key=lambda item: item.stat().st_mtime, reverse=True)
    for file in files[keep:]:
        file.unlink(missing_ok=True)


def create_backup_archive(dump_path: Path, archive_path: Path, created_at: datetime) -> None:
    manifest = {
        "app": "obsidian-sync",
        "created_at": created_at.isoformat(),
        "format": "postgresql-custom-dump",
        "database_dump": "database.dump",
        "restore": "pg_restore --clean --if-exists --no-owner --dbname \"$DATABASE_URL\" database.dump",
    }
    restore_readme = """# Obsidian Sync Backup Restore

This archive contains a PostgreSQL custom-format dump.

Restore:

```bash
unzip obsidian-sync-YYYYMMDD-HHMMSS.zip
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" database.dump
```
"""
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(dump_path, "database.dump")
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr("README-restore.md", restore_readme)


def backup_config_snapshot(settings: Settings) -> dict:
    return {
        "enabled": settings.admin_backup_enabled,
        "interval_hours": settings.admin_backup_interval_hours,
        "directory": settings.admin_backup_directory,
        "keep_local": settings.admin_backup_keep_local,
        "rclone_remote_configured": bool(settings.admin_backup_rclone_remote),
        "rclone_config": settings.admin_backup_rclone_config,
    }


def google_drive_status(settings: Settings) -> dict:
    token_path = Path(settings.admin_google_token_file)
    return {
        "configured": bool(settings.admin_google_client_id and settings.admin_google_client_secret),
        "connected": token_path.exists(),
        "token_file": settings.admin_google_token_file,
        "folder_id_configured": bool(settings.admin_google_drive_folder_id),
        "folder_name": settings.admin_google_drive_folder_name,
        "redirect_uri": google_redirect_uri(settings) if settings.admin_google_client_id else "",
    }


def google_redirect_uri(settings: Settings) -> str:
    if settings.admin_google_redirect_uri:
        return settings.admin_google_redirect_uri
    public_url = settings.admin_public_url.rstrip("/")
    if public_url:
        return f"{public_url}/admin/google/callback"
    return "/admin/google/callback"


def sign_google_state(settings: Settings) -> str:
    payload = json.dumps({"exp": int((datetime.now(UTC) + timedelta(minutes=15)).timestamp())}, separators=(",", ":")).encode()
    payload_b64 = base64.urlsafe_b64encode(payload).rstrip(b"=").decode()
    signature = hmac.new(state_secret(settings), payload_b64.encode(), hashlib.sha256).digest()
    signature_b64 = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    return f"{payload_b64}.{signature_b64}"


def verify_google_state(settings: Settings, state: str) -> bool:
    try:
        payload_b64, signature_b64 = state.split(".", 1)
        expected = hmac.new(state_secret(settings), payload_b64.encode(), hashlib.sha256).digest()
        actual = base64.urlsafe_b64decode(signature_b64 + "=" * (-len(signature_b64) % 4))
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
    except Exception:
        return False
    return hmac.compare_digest(expected, actual) and int(payload.get("exp", 0)) >= int(datetime.now(UTC).timestamp())


def state_secret(settings: Settings) -> bytes:
    return (settings.admin_token or settings.jwt_secret).encode("utf-8")


async def exchange_google_code(settings: Settings, code: str) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": settings.admin_google_client_id,
                "client_secret": settings.admin_google_client_secret,
                "redirect_uri": google_redirect_uri(settings),
                "grant_type": "authorization_code",
            },
        )
        response.raise_for_status()
        token = response.json()
    if "refresh_token" not in token:
        existing = load_google_token(settings)
        if existing.get("refresh_token"):
            token["refresh_token"] = existing["refresh_token"]
        else:
            raise RuntimeError("Google did not return a refresh token; reconnect with prompt consent.")
    return token


async def refresh_google_access_token(settings: Settings) -> str:
    token = load_google_token(settings)
    refresh_token = token.get("refresh_token")
    if not refresh_token:
        raise RuntimeError("Google Drive is not connected")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": settings.admin_google_client_id,
                "client_secret": settings.admin_google_client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
        response.raise_for_status()
        refreshed = response.json()
    token.update(refreshed)
    token["refresh_token"] = refresh_token
    save_google_token(settings, token)
    return refreshed["access_token"]


def load_google_token(settings: Settings) -> dict:
    token_path = Path(settings.admin_google_token_file)
    if not token_path.exists():
        return {}
    return json.loads(token_path.read_text(encoding="utf-8"))


def save_google_token(settings: Settings, token: dict) -> None:
    token_path = Path(settings.admin_google_token_file)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(json.dumps(token, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        token_path.chmod(0o600)
    except OSError:
        pass


async def upload_to_google_drive(settings: Settings, backup_path: Path) -> str:
    access_token = await refresh_google_access_token(settings)
    folder_id = settings.admin_google_drive_folder_id or await ensure_google_drive_folder(settings, access_token)
    metadata = {"name": backup_path.name}
    if folder_id:
        metadata["parents"] = [folder_id]
    boundary = "obsidian-sync-boundary"
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata, ensure_ascii=False)}\r\n"
        f"--{boundary}\r\n"
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8") + backup_path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("utf-8")
    async with httpx.AsyncClient(timeout=settings.admin_backup_timeout_seconds) as client:
        response = await client.post(
            GOOGLE_DRIVE_UPLOAD_URL,
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": f"multipart/related; boundary={boundary}"},
            content=body,
        )
        response.raise_for_status()
        file_id = response.json().get("id", "")
    if folder_id:
        await prune_google_drive_backups(settings, access_token, folder_id)
    return file_id


async def ensure_google_drive_folder(settings: Settings, access_token: str) -> str:
    folder_name = settings.admin_google_drive_folder_name.strip()
    if not folder_name:
        return ""
    escaped_folder_name = folder_name.replace("'", "\\'")
    query = f"name='{escaped_folder_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            GOOGLE_DRIVE_FILES_URL,
            params={"q": query, "fields": "files(id,name)", "spaces": "drive"},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        response.raise_for_status()
        files = response.json().get("files", [])
        if files:
            return files[0]["id"]
        response = await client.post(
            GOOGLE_DRIVE_FILES_URL,
            params={"fields": "id"},
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            json={"name": folder_name, "mimeType": "application/vnd.google-apps.folder"},
        )
        response.raise_for_status()
        return response.json()["id"]


async def prune_google_drive_backups(settings: Settings, access_token: str, folder_id: str) -> None:
    keep = settings.admin_backup_keep_local
    if keep <= 0:
        return
    query = f"'{folder_id}' in parents and name contains 'obsidian-sync-' and name contains '.zip' and trashed=false"
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            GOOGLE_DRIVE_FILES_URL,
            params={"q": query, "fields": "files(id,name,createdTime)", "orderBy": "createdTime desc", "pageSize": 100},
            headers={"Authorization": f"Bearer {access_token}"},
        )
        response.raise_for_status()
        files = response.json().get("files", [])
        for file in files[keep:]:
            await client.delete(
                f"{GOOGLE_DRIVE_FILES_URL}/{file['id']}",
                headers={"Authorization": f"Bearer {access_token}"},
            )


def callback_html(ok: bool, message: str) -> str:
    status_text = "连接成功" if ok else "连接失败"
    color = "#166534" if ok else "#991b1b"
    return f"""
    <!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><title>Google Drive</title></head>
    <body style="font-family: system-ui, sans-serif; padding: 32px;">
      <h1 style="color:{color}">{status_text}</h1>
      <p>{message}</p>
    </body></html>
    """


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
    .login { min-height: calc(100vh - 82px); display: grid; place-items: center; padding: 24px; }
    .login .card { width: min(420px, 100%); }
    .login input { width: 100%; box-sizing: border-box; margin: 10px 0; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <header>
    <h1>Obsidian Sync Admin</h1>
    <div class="toolbar">
      <button class="secondary" onclick="logout()">退出</button>
      <button onclick="refreshAll()">刷新</button>
    </div>
  </header>
  <section id="login" class="login">
    <div class="card">
      <h2>管理面板登录</h2>
      <div class="muted">请输入服务器 ADMIN_TOKEN。</div>
      <input id="token" type="password" placeholder="ADMIN_TOKEN" onkeydown="if(event.key === 'Enter') saveToken()" />
      <div class="toolbar">
        <button onclick="saveToken()">登录</button>
      </div>
      <div id="loginError" class="bad" style="margin-top:10px"></div>
    </div>
  </section>
  <main id="dashboard" class="hidden">
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
        <h2>Google Drive</h2>
        <div id="googleDriveStatus" class="muted"></div>
        <div class="toolbar" style="margin-top:12px">
          <button onclick="connectGoogleDrive()">连接 Google Drive</button>
          <button class="secondary" onclick="disconnectGoogleDrive()">断开</button>
        </div>
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
    function showDashboard(show){
      document.getElementById('login').classList.toggle('hidden', show);
      document.getElementById('dashboard').classList.toggle('hidden', !show);
    }
    async function saveToken(){
      tokenInput.value = tokenInput.value.trim();
      localStorage.setItem('adminToken', tokenInput.value);
      try {
        await loadStatus();
        showDashboard(true);
        document.getElementById('loginError').textContent = '';
        await Promise.allSettled([loadBackups(), loadHermes()]);
      } catch (err) {
        showDashboard(false);
        document.getElementById('loginError').textContent = `登录失败：${err.message}`;
      }
    }
    function logout(){
      localStorage.removeItem('adminToken');
      tokenInput.value = '';
      showDashboard(false);
    }
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
      const g = data.google_drive;
      document.getElementById('backupConfig').innerHTML = `定时：<b class="${b.enabled ? 'ok' : 'bad'}">${b.enabled ? '开启' : '关闭'}</b>；间隔：${b.interval_hours}h；目录：<code>${b.directory}</code>；Google Drive OAuth：${g.connected ? '<span class="ok">已连接</span>' : '<span class="bad">未连接</span>'}；rclone fallback：${b.rclone_remote_configured ? '<span class="ok">已配置</span>' : '<span class="bad">未配置</span>'}`;
      document.getElementById('googleDriveStatus').innerHTML = `OAuth：${g.configured ? '<span class="ok">已配置</span>' : '<span class="bad">未配置 Client</span>'}；连接：${g.connected ? '<span class="ok">已连接</span>' : '<span class="bad">未连接</span>'}；目录：<code>${g.folder_name}</code>`;
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
    async function connectGoogleDrive(){
      const data = await api('/admin/api/google-drive/auth-url', { method: 'POST' });
      window.open(data.auth_url, '_blank', 'noopener,noreferrer');
    }
    async function disconnectGoogleDrive(){
      await api('/admin/api/google-drive/disconnect', { method: 'POST' });
      await loadStatus();
    }
    if (tokenInput.value) {
      saveToken();
    } else {
      showDashboard(false);
    }
  </script>
</body>
</html>
"""
