import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.database import get_session
from app.hermes_agent import (
    append_hermes_block,
    build_vault_index,
    decrypt_note,
    derive_kek,
    encrypt_file,
    hermes_device,
    normalize_path,
    path_hash,
    score_candidates,
)
from app.models import HermesQueue, Note, NoteVersion, SyncLog, Vault
from app.security import verify_hermes_key

router = APIRouter(prefix="/api/v1/hermes/tools", dependencies=[Depends(verify_hermes_key)])


class NoteWriteRequest(BaseModel):
    path: str = Field(min_length=1)
    content: str = Field(min_length=1)


class NoteAppendRequest(NoteWriteRequest):
    heading: str = "Hermes"


class QueueFailRequest(BaseModel):
    error: str = Field(min_length=1, max_length=1000)


async def hermes_context(settings: Settings, session: AsyncSession) -> tuple[uuid.UUID, uuid.UUID, bytes]:
    if not settings.hermes_agent_vault_id or not settings.hermes_agent_vault_password:
        raise HTTPException(status_code=503, detail="Hermes vault credentials are not configured")
    vault_id = uuid.UUID(settings.hermes_agent_vault_id)
    vault = await session.get(Vault, vault_id)
    if vault is None:
        raise HTTPException(status_code=404, detail="Hermes vault not found")
    device = await hermes_device(session, vault_id)
    return vault_id, device.id, derive_kek(settings.hermes_agent_vault_password)


@router.get("/queue/next")
async def queue_next(session: AsyncSession = Depends(get_session), settings: Settings = Depends(get_settings)) -> dict:
    vault_id, _device_id, _kek = await hermes_context(settings, session)
    query = (
        select(HermesQueue)
        .where(HermesQueue.vault_id == vault_id, HermesQueue.status == "pending")
        .order_by(HermesQueue.created_at.asc(), HermesQueue.id.asc())
        .limit(1)
    )
    item = (await session.execute(query)).scalar_one_or_none()
    if item is None:
        return {"item": None}
    return {
        "item": {
            "id": item.id,
            "target_note_path": item.target_note_path,
            "merge_content": item.merge_content,
            "source_url": item.source_url,
            "source_type": item.source_type,
            "created_at": item.created_at.isoformat() if item.created_at else "",
        }
    }


@router.get("/notes/search")
async def search_notes(
    query: str = Query(default="", max_length=500),
    limit: int = Query(default=8, ge=1, le=30),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict:
    vault_id, _device_id, kek = await hermes_context(settings, session)
    index = await build_vault_index(session, vault_id, kek)
    if query.strip():
        scored = score_candidates(query, index, [])
    else:
        scored = [(0, note, "") for note in index]
    return {
        "notes": [
            {
                "path": note.path,
                "title": note.title,
                "score": score,
                "headings": note.headings[:12],
                "preview": note.content[:500],
            }
            for score, note, _heading in scored[:limit]
        ]
    }


@router.get("/notes/read")
async def read_note(
    path: str = Query(min_length=1),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict:
    vault_id, _device_id, kek = await hermes_context(settings, session)
    note, content = await find_note_by_path(session, vault_id, kek, path)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"path": normalize_path(path), "content": content}


@router.post("/notes/create")
async def create_note(payload: NoteWriteRequest, session: AsyncSession = Depends(get_session), settings: Settings = Depends(get_settings)) -> dict:
    vault_id, device_id, kek = await hermes_context(settings, session)
    path = normalize_path(payload.path)
    existing, _content = await find_note_by_path(session, vault_id, kek, path)
    if existing is not None:
        raise HTTPException(status_code=409, detail="Note already exists")
    note = Note(vault_id=vault_id, path_hash=path_hash(path), version_vector={})
    session.add(note)
    await write_note(session, vault_id, device_id, kek, note, path, payload.content, "create")
    await session.commit()
    return {"path": path, "operation": "create"}


@router.post("/notes/update")
async def update_note(payload: NoteWriteRequest, session: AsyncSession = Depends(get_session), settings: Settings = Depends(get_settings)) -> dict:
    vault_id, device_id, kek = await hermes_context(settings, session)
    path = normalize_path(payload.path)
    note, _content = await find_note_by_path(session, vault_id, kek, path)
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    await write_note(session, vault_id, device_id, kek, note, path, payload.content, "update")
    await session.commit()
    return {"path": path, "operation": "update"}


@router.post("/notes/append")
async def append_note(payload: NoteAppendRequest, session: AsyncSession = Depends(get_session), settings: Settings = Depends(get_settings)) -> dict:
    vault_id, device_id, kek = await hermes_context(settings, session)
    path = normalize_path(payload.path)
    note, content = await find_note_by_path(session, vault_id, kek, path)
    if note is None or content is None:
        raise HTTPException(status_code=404, detail="Note not found")
    next_content = append_hermes_block(content, payload.content, payload.heading or "Hermes")
    await write_note(session, vault_id, device_id, kek, note, path, next_content, "update")
    await session.commit()
    return {"path": path, "operation": "append"}


@router.post("/queue/{item_id}/complete")
async def complete_queue_item(item_id: int, session: AsyncSession = Depends(get_session), settings: Settings = Depends(get_settings)) -> dict:
    vault_id, _device_id, _kek = await hermes_context(settings, session)
    item = await session.get(HermesQueue, item_id)
    if item is None or item.vault_id != vault_id:
        raise HTTPException(status_code=404, detail="Queue item not found")
    item.status = "merged"
    item.merged_at = datetime.now(UTC)
    item.error_message = None
    await session.commit()
    return {"status": item.status, "id": item.id}


@router.post("/queue/{item_id}/fail")
async def fail_queue_item(
    item_id: int,
    payload: QueueFailRequest,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict:
    vault_id, _device_id, _kek = await hermes_context(settings, session)
    item = await session.get(HermesQueue, item_id)
    if item is None or item.vault_id != vault_id:
        raise HTTPException(status_code=404, detail="Queue item not found")
    item.status = "failed"
    item.error_message = payload.error[:1000]
    await session.commit()
    return {"status": item.status, "id": item.id}


async def find_note_by_path(session: AsyncSession, vault_id: uuid.UUID, kek: bytes, path: str) -> tuple[Note | None, str | None]:
    normalized = normalize_path(path)
    notes = (await session.execute(select(Note).where(Note.vault_id == vault_id, Note.deleted_at.is_(None)))).scalars().all()
    for note in notes:
        note_path, content = decrypt_note(kek, note)
        if normalize_path(note_path) == normalized:
            return note, content
    return None, None


async def write_note(
    session: AsyncSession,
    vault_id: uuid.UUID,
    device_id: uuid.UUID,
    kek: bytes,
    note: Note,
    path: str,
    content: str,
    operation: str,
) -> None:
    encrypted = encrypt_file(kek, path, content.encode("utf-8"))
    vector = dict(note.version_vector or {})
    vector[str(device_id)] = int(vector.get(str(device_id), 0)) + 1
    note.path_hash = encrypted["path_hash"]
    note.path_encrypted = encrypted["path_encrypted"]
    note.content_encrypted = encrypted["content_encrypted"]
    note.dek_encrypted = encrypted["dek_encrypted"]
    note.version_vector = vector
    note.file_size = len(content.encode("utf-8"))
    note.mime_type = "text/markdown"
    note.deleted_at = None
    note.modified_at = datetime.now(UTC)
    await session.flush()
    session.add(
        NoteVersion(
            vault_id=vault_id,
            note_id=note.id,
            device_id=device_id,
            operation=operation,
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
            operation=operation,
            path_hash=note.path_hash,
            version_vector=note.version_vector,
        )
    )
