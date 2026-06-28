import asyncio
import logging
import uuid
from contextlib import suppress
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import Select, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import SessionLocal, engine, get_session
from app.hermes_agent import run_hermes_agent_loop
from app.models import Device, HermesQueue, Note, NoteVersion, SyncLog, Vault
from app.schemas import (
    AcceptedChange,
    ChangesResponse,
    ConflictChange,
    DeviceInfo,
    DevicesResponse,
    HealthResponse,
    HermesMergeRequest,
    HermesMergeResponse,
    HermesQueueCompleteResponse,
    HermesQueueItem,
    HermesQueueResponse,
    LoginRequest,
    LoginResponse,
    NoteVersionInfo,
    NoteVersionPayload,
    NoteVersionsResponse,
    PushRequest,
    PushResponse,
    RestoreVersionResponse,
    RevokeDeviceResponse,
    RegisterRequest,
    RegisterResponse,
    RemoteChange,
    ResolveRequest,
    ResolveResponse,
)
from app.security import create_token, current_auth, hash_password, verify_hermes_key, verify_password
from app.sync import VectorOrder, compare_vectors

app = FastAPI(title="Obsidian Sync API", version="0.1.0")
hermes_agent_task: asyncio.Task | None = None
logger = logging.getLogger("obsidian-sync-api")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def migrate_schema() -> None:
    global hermes_agent_task
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ"))
        await conn.execute(
            text(
                """
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
                )
                """
            )
        )
        await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_note_versions_note_time ON note_versions(note_id, created_at DESC)"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS idx_note_versions_vault_time ON note_versions(vault_id, created_at DESC)"))
    settings = get_settings()
    if settings.hermes_agent_enabled and settings.hermes_agent_vault_id and settings.hermes_agent_vault_password:
        hermes_agent_task = asyncio.create_task(run_hermes_agent_loop(settings, SessionLocal))
    elif settings.hermes_agent_enabled:
        logger.warning("Hermes Agent enabled but HERMES_AGENT_VAULT_ID or HERMES_AGENT_VAULT_PASSWORD is missing.")


@app.on_event("shutdown")
async def stop_hermes_agent() -> None:
    if hermes_agent_task:
        hermes_agent_task.cancel()
        with suppress(asyncio.CancelledError):
            await hermes_agent_task


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/api/v1/auth/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest, session: AsyncSession = Depends(get_session)) -> RegisterResponse:
    vault = Vault(name=payload.vault_name, password_hash=hash_password(payload.password))
    session.add(vault)
    await session.flush()

    device = Device(vault_id=vault.id, device_name=payload.device_name, platform=payload.platform, last_seen=datetime.now(UTC))
    session.add(device)
    await session.commit()

    return RegisterResponse(vault_id=vault.id, device_id=device.id, token=create_token(vault.id, device.id))


@app.post("/api/v1/auth/login", response_model=LoginResponse)
async def login(payload: LoginRequest, session: AsyncSession = Depends(get_session)) -> LoginResponse:
    vault = await session.get(Vault, payload.vault_id)
    if vault is None or not verify_password(payload.password, vault.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid vault credentials")

    device = Device(vault_id=vault.id, device_name=payload.device_name, platform=payload.platform, last_seen=datetime.now(UTC))
    session.add(device)
    await session.commit()

    return LoginResponse(token=create_token(vault.id, device.id), device_id=device.id)


@app.get("/api/v1/sync/changes", response_model=ChangesResponse)
async def changes(
    auth: Annotated[tuple, Depends(current_auth)],
    since: datetime | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> ChangesResponse:
    vault_id, device_id, session = auth
    query = (
        select(SyncLog, Note)
        .join(Note, SyncLog.note_id == Note.id, isouter=True)
        .where(SyncLog.vault_id == vault_id)
        .where((SyncLog.device_id.is_(None)) | (SyncLog.device_id != device_id))
        .order_by(SyncLog.synced_at.asc(), SyncLog.id.asc())
        .limit(limit)
    )
    if since is not None:
        query = query.where(SyncLog.synced_at > since)

    rows = (await session.execute(query)).all()
    remote_changes = []
    for log, note in rows:
        remote_changes.append(
            RemoteChange(
                note_id=log.note_id,
                path_hash=log.path_hash,
                encrypted_path=note.path_encrypted if note else None,
                encrypted_content=note.content_encrypted if note and log.operation != "delete" else None,
                encrypted_dek=note.dek_encrypted if note and log.operation != "delete" else None,
                version_vector=log.version_vector,
                operation=log.operation,
                modified_at=log.synced_at,
            )
        )
    return ChangesResponse(changes=remote_changes)


@app.post("/api/v1/sync/push", response_model=PushResponse)
async def push(payload: PushRequest, auth: Annotated[tuple, Depends(current_auth)]) -> PushResponse:
    vault_id, device_id, session = auth
    accepted: list[AcceptedChange] = []
    conflicts: list[ConflictChange] = []

    for change in payload.changes:
        note = await _get_note_by_path_hash(session, vault_id, change.path_hash)
        if note is not None and compare_vectors(change.version_vector, note.version_vector) is VectorOrder.CONCURRENT:
            conflicts.append(
                ConflictChange(
                    note_id=note.id,
                    path_hash=note.path_hash,
                    server_version_vector=note.version_vector,
                    client_version_vector=change.version_vector,
                    encrypted_path=note.path_encrypted,
                    encrypted_content=note.content_encrypted,
                    encrypted_dek=note.dek_encrypted,
                )
            )

        if change.operation == "delete":
            if note is None:
                continue
            note.deleted_at = datetime.now(UTC)
            note.version_vector = change.version_vector
            operation = "delete"
        else:
            if change.encrypted_content is None or change.encrypted_dek is None:
                raise HTTPException(status_code=422, detail="encrypted_content and encrypted_dek are required")
            if note is None:
                note = Note(
                    vault_id=vault_id,
                    path_hash=change.path_hash,
                    path_encrypted=change.encrypted_path,
                    content_encrypted=change.encrypted_content,
                    dek_encrypted=change.encrypted_dek,
                    version_vector=change.version_vector,
                    file_size=change.file_size,
                    mime_type=change.mime_type,
                )
                session.add(note)
                operation = "create"
            else:
                note.path_encrypted = change.encrypted_path
                note.content_encrypted = change.encrypted_content
                note.dek_encrypted = change.encrypted_dek
                note.version_vector = change.version_vector
                note.file_size = change.file_size
                note.mime_type = change.mime_type
                note.deleted_at = None
                operation = "update"

        await session.flush()
        session.add(
            NoteVersion(
                vault_id=vault_id,
                note_id=note.id,
                device_id=device_id,
                operation=operation,
                path_hash=note.path_hash,
                path_encrypted=note.path_encrypted,
                content_encrypted=None if operation == "delete" else note.content_encrypted,
                dek_encrypted=None if operation == "delete" else note.dek_encrypted,
                version_vector=note.version_vector,
                file_size=note.file_size,
                mime_type=note.mime_type,
            )
        )
        session.add(
            SyncLog(
                vault_id=vault_id,
                note_id=note.id,
                device_id=device_id,
                operation=operation,
                path_hash=change.path_hash,
                version_vector=change.version_vector,
            )
        )
        accepted.append(
            AcceptedChange(
                note_id=note.id,
                path_hash=change.path_hash,
                operation=operation,
                version_vector=change.version_vector,
            )
        )

    await session.commit()
    return PushResponse(accepted=accepted, conflicts=conflicts)


@app.get("/api/v1/sync/history", response_model=NoteVersionsResponse)
async def history(
    auth: Annotated[tuple, Depends(current_auth)],
    path_hash: str = Query(min_length=1),
    limit: int = Query(default=30, ge=1, le=100),
) -> NoteVersionsResponse:
    vault_id, _device_id, session = auth
    note = await _get_note_by_path_hash(session, vault_id, path_hash)
    if note is None:
        return NoteVersionsResponse(versions=[])
    query = (
        select(NoteVersion)
        .where(NoteVersion.vault_id == vault_id, NoteVersion.note_id == note.id)
        .order_by(NoteVersion.created_at.desc(), NoteVersion.id.desc())
        .limit(limit)
    )
    versions = (await session.execute(query)).scalars().all()
    return NoteVersionsResponse(
        versions=[
            NoteVersionInfo(
                id=version.id,
                note_id=version.note_id,
                operation=version.operation,
                version_vector=version.version_vector,
                file_size=version.file_size,
                mime_type=version.mime_type,
                created_at=version.created_at,
            )
            for version in versions
        ]
    )


@app.get("/api/v1/sync/history/{version_id}", response_model=NoteVersionPayload)
async def history_payload(version_id: int, auth: Annotated[tuple, Depends(current_auth)]) -> NoteVersionPayload:
    vault_id, _device_id, session = auth
    version = await session.get(NoteVersion, version_id)
    if version is None or version.vault_id != vault_id:
        raise HTTPException(status_code=404, detail="Version not found")
    return NoteVersionPayload(
        id=version.id,
        note_id=version.note_id,
        operation=version.operation,
        path_hash=version.path_hash,
        encrypted_path=version.path_encrypted,
        encrypted_content=version.content_encrypted,
        encrypted_dek=version.dek_encrypted,
        version_vector=version.version_vector,
        file_size=version.file_size,
        mime_type=version.mime_type,
        created_at=version.created_at,
    )


@app.post("/api/v1/sync/history/{version_id}/restore", response_model=RestoreVersionResponse)
async def restore_version(version_id: int, auth: Annotated[tuple, Depends(current_auth)]) -> RestoreVersionResponse:
    vault_id, device_id, session = auth
    version = await session.get(NoteVersion, version_id)
    if version is None or version.vault_id != vault_id:
        raise HTTPException(status_code=404, detail="Version not found")
    if version.operation == "delete" or version.content_encrypted is None or version.dek_encrypted is None:
        raise HTTPException(status_code=422, detail="Deleted versions cannot be restored directly")
    note = await session.get(Note, version.note_id)
    if note is None or note.vault_id != vault_id:
        raise HTTPException(status_code=404, detail="Note not found")
    vector = dict(version.version_vector)
    vector[str(device_id)] = int(vector.get(str(device_id), 0)) + 1
    note.path_hash = version.path_hash
    note.path_encrypted = version.path_encrypted
    note.content_encrypted = version.content_encrypted
    note.dek_encrypted = version.dek_encrypted
    note.version_vector = vector
    note.file_size = version.file_size
    note.mime_type = version.mime_type
    note.deleted_at = None
    await session.flush()
    session.add(
        NoteVersion(
            vault_id=vault_id,
            note_id=note.id,
            device_id=device_id,
            operation="restore",
            path_hash=note.path_hash,
            path_encrypted=note.path_encrypted,
            content_encrypted=note.content_encrypted,
            dek_encrypted=note.dek_encrypted,
            version_vector=note.version_vector,
            file_size=note.file_size,
            mime_type=note.mime_type,
        )
    )
    session.add(
        SyncLog(
            vault_id=vault_id,
            note_id=note.id,
            device_id=device_id,
            operation="update",
            path_hash=note.path_hash,
            version_vector=note.version_vector,
        )
    )
    await session.commit()
    return RestoreVersionResponse(status="restored", note_id=note.id, version_vector=note.version_vector)


@app.get("/api/v1/devices", response_model=DevicesResponse)
async def list_devices(auth: Annotated[tuple, Depends(current_auth)]) -> DevicesResponse:
    vault_id, device_id, session = auth
    query = select(Device).where(Device.vault_id == vault_id).order_by(Device.created_at.desc())
    devices = (await session.execute(query)).scalars().all()
    return DevicesResponse(
        devices=[
            DeviceInfo(
                id=device.id,
                device_name=device.device_name,
                platform=device.platform,
                last_seen=device.last_seen,
                created_at=device.created_at,
                revoked_at=device.revoked_at,
                current=device.id == device_id,
            )
            for device in devices
        ]
    )


@app.delete("/api/v1/devices/{target_device_id}", response_model=RevokeDeviceResponse)
async def revoke_device(target_device_id: str, auth: Annotated[tuple, Depends(current_auth)]) -> RevokeDeviceResponse:
    vault_id, device_id, session = auth
    try:
        target_uuid = uuid.UUID(target_device_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid device id") from exc
    if target_uuid == device_id:
        raise HTTPException(status_code=422, detail="Cannot revoke the current device")
    device = await session.get(Device, target_uuid)
    if device is None or device.vault_id != vault_id:
        raise HTTPException(status_code=404, detail="Device not found")
    device.revoked_at = datetime.now(UTC)
    await session.commit()
    return RevokeDeviceResponse(status="revoked")


@app.post("/api/v1/sync/resolve", response_model=ResolveResponse)
async def resolve(payload: ResolveRequest, auth: Annotated[tuple, Depends(current_auth)]) -> ResolveResponse:
    vault_id, device_id, session = auth
    note = await session.get(Note, payload.note_id)
    if note is None or note.vault_id != vault_id:
        raise HTTPException(status_code=404, detail="Note not found")
    note.version_vector = payload.accepted_version_vector
    session.add(
        SyncLog(
            vault_id=vault_id,
            note_id=note.id,
            device_id=device_id,
            operation="update",
            path_hash=note.path_hash,
            version_vector=note.version_vector,
        )
    )
    await session.commit()
    return ResolveResponse(status="resolved")


@app.post("/api/v1/hermes/merge", response_model=HermesMergeResponse, dependencies=[Depends(verify_hermes_key)])
async def hermes_merge(payload: HermesMergeRequest, session: AsyncSession = Depends(get_session)) -> HermesMergeResponse:
    vault = await session.get(Vault, payload.vault_id)
    if vault is None:
        raise HTTPException(status_code=404, detail="Vault not found")
    item = HermesQueue(
        vault_id=payload.vault_id,
        target_note_path=payload.note_path,
        merge_content=payload.merge_content,
        source_url=payload.source_url,
        source_type=payload.source_type,
        status="pending",
    )
    session.add(item)
    await session.commit()
    return HermesMergeResponse(status=item.status, queue_id=item.id)


@app.get("/api/v1/hermes/queue", response_model=HermesQueueResponse)
async def hermes_queue(
    auth: Annotated[tuple, Depends(current_auth)],
    status_filter: str = Query(default="pending", alias="status"),
    limit: int = Query(default=20, ge=1, le=100),
) -> HermesQueueResponse:
    vault_id, _device_id, session = auth
    query = (
        select(HermesQueue)
        .where(HermesQueue.vault_id == vault_id, HermesQueue.status == status_filter)
        .order_by(HermesQueue.created_at.asc(), HermesQueue.id.asc())
        .limit(limit)
    )
    items = (await session.execute(query)).scalars().all()
    return HermesQueueResponse(
        items=[
            HermesQueueItem(
                id=item.id,
                target_note_path=item.target_note_path,
                merge_content=item.merge_content,
                source_url=item.source_url,
                source_type=item.source_type,
                status=item.status,
                created_at=item.created_at,
            )
            for item in items
        ]
    )


@app.post("/api/v1/hermes/queue/{item_id}/complete", response_model=HermesQueueCompleteResponse)
async def hermes_queue_complete(item_id: int, auth: Annotated[tuple, Depends(current_auth)]) -> HermesQueueCompleteResponse:
    vault_id, _device_id, session = auth
    item = await session.get(HermesQueue, item_id)
    if item is None or item.vault_id != vault_id:
        raise HTTPException(status_code=404, detail="Queue item not found")
    item.status = "merged"
    item.merged_at = datetime.now(UTC)
    await session.commit()
    return HermesQueueCompleteResponse(status=item.status)


async def _get_note_by_path_hash(session: AsyncSession, vault_id, path_hash: str) -> Note | None:
    query: Select = select(Note).where(Note.vault_id == vault_id, Note.path_hash == path_hash)
    return (await session.execute(query)).scalar_one_or_none()
