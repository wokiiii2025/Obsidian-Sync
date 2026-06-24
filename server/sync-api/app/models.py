import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, LargeBinary, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Vault(Base):
    __tablename__ = "vaults"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    devices: Mapped[list["Device"]] = relationship(back_populates="vault", cascade="all, delete-orphan")


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vault_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"))
    device_name: Mapped[str | None] = mapped_column(Text)
    platform: Mapped[str | None] = mapped_column(Text)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    vault: Mapped[Vault] = relationship(back_populates="devices")


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vault_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"))
    path_hash: Mapped[str] = mapped_column(Text, nullable=False)
    path_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    content_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    dek_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    version_vector: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    file_size: Mapped[int | None] = mapped_column(Integer)
    mime_type: Mapped[str] = mapped_column(Text, default="text/markdown")
    modified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class NoteVersion(Base):
    __tablename__ = "note_versions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    vault_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"))
    note_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("notes.id", ondelete="CASCADE"))
    device_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    operation: Mapped[str] = mapped_column(Text, nullable=False)
    path_hash: Mapped[str] = mapped_column(Text, nullable=False)
    path_encrypted: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    content_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    dek_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    version_vector: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    file_size: Mapped[int | None] = mapped_column(Integer)
    mime_type: Mapped[str] = mapped_column(Text, default="text/markdown")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SyncLog(Base):
    __tablename__ = "sync_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    vault_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"))
    note_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("notes.id", ondelete="SET NULL"))
    device_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    operation: Mapped[str] = mapped_column(Text, nullable=False)
    path_hash: Mapped[str | None] = mapped_column(Text)
    version_vector: Mapped[dict | None] = mapped_column(JSONB)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class HermesQueue(Base):
    __tablename__ = "hermes_queue"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    vault_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("vaults.id", ondelete="CASCADE"))
    target_note_path: Mapped[str | None] = mapped_column(Text)
    merge_content: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    source_type: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="pending")
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    merged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
