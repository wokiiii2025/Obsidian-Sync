from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, status
from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import Device, HermesQueue, Note, SyncLog, Vault
from app.schemas import (
    AcceptedChange,
    ChangesResponse,
    ConflictChange,
    HealthResponse,
    HermesMergeRequest,
    HermesMergeResponse,
    LoginRequest,
    LoginResponse,
    PushRequest,
    PushResponse,
    RegisterRequest,
    RegisterResponse,
    RemoteChange,
    ResolveRequest,
    ResolveResponse,
)
from app.security import create_token, current_auth, hash_password, verify_hermes_key, verify_password
from app.sync import VectorOrder, compare_vectors

app = FastAPI(title="Obsidian Sync API", version="0.1.0")


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


async def _get_note_by_path_hash(session: AsyncSession, vault_id, path_hash: str) -> Note | None:
    query: Select = select(Note).where(Note.vault_id == vault_id, Note.path_hash == path_hash)
    return (await session.execute(query)).scalar_one_or_none()
