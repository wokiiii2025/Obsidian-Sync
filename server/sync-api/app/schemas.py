import base64
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, PlainSerializer


def decode_base64(value: str | bytes) -> bytes:
    if isinstance(value, bytes):
        return value
    return base64.b64decode(value)


def encode_base64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


Base64Bytes = Annotated[
    bytes,
    BeforeValidator(decode_base64),
    PlainSerializer(encode_base64, return_type=str),
]


class RegisterRequest(BaseModel):
    vault_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=8)
    device_name: str | None = None
    platform: str | None = None


class RegisterResponse(BaseModel):
    vault_id: uuid.UUID
    device_id: uuid.UUID
    token: str


class LoginRequest(BaseModel):
    vault_id: uuid.UUID
    password: str
    device_name: str | None = None
    platform: str | None = None


class LoginResponse(BaseModel):
    token: str
    device_id: uuid.UUID


class PushChange(BaseModel):
    path_hash: str
    encrypted_path: Base64Bytes
    encrypted_content: Base64Bytes | None = None
    encrypted_dek: Base64Bytes | None = None
    version_vector: dict[str, int] = Field(default_factory=dict)
    operation: Literal["create", "update", "delete"]
    file_size: int | None = None
    mime_type: str = "text/markdown"


class AcceptedChange(BaseModel):
    note_id: uuid.UUID
    path_hash: str
    operation: str
    version_vector: dict[str, int]


class ConflictChange(BaseModel):
    note_id: uuid.UUID
    path_hash: str
    server_version_vector: dict[str, int]
    client_version_vector: dict[str, int]
    encrypted_path: Base64Bytes
    encrypted_content: Base64Bytes | None
    encrypted_dek: Base64Bytes | None


class PushRequest(BaseModel):
    changes: list[PushChange]


class PushResponse(BaseModel):
    accepted: list[AcceptedChange]
    conflicts: list[ConflictChange]


class RemoteChange(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    note_id: uuid.UUID | None
    path_hash: str | None
    encrypted_path: Base64Bytes | None
    encrypted_content: Base64Bytes | None
    encrypted_dek: Base64Bytes | None
    version_vector: dict[str, int] | None
    operation: str
    modified_at: datetime


class ChangesResponse(BaseModel):
    changes: list[RemoteChange]


class ResolveRequest(BaseModel):
    note_id: uuid.UUID
    accepted_version_vector: dict[str, int]


class ResolveResponse(BaseModel):
    status: str


class HermesMergeRequest(BaseModel):
    vault_id: uuid.UUID
    note_path: str
    merge_content: str
    source_url: str | None = None
    source_type: str | None = None


class HermesMergeResponse(BaseModel):
    status: str
    queue_id: int


class HealthResponse(BaseModel):
    status: str
