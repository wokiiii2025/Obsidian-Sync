import uuid
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.database import get_session
from app.models import Device

password_context = CryptContext(schemes=["argon2"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return password_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return password_context.verify(password, password_hash)


def create_token(vault_id: uuid.UUID, device_id: uuid.UUID, settings: Settings | None = None) -> str:
    active_settings = settings or get_settings()
    expires_at = datetime.now(UTC) + timedelta(minutes=active_settings.jwt_expire_minutes)
    payload = {
        "sub": str(vault_id),
        "device_id": str(device_id),
        "exp": expires_at,
    }
    return jwt.encode(payload, active_settings.jwt_secret, algorithm=active_settings.jwt_algorithm)


async def current_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    settings: Settings = Depends(get_settings),
    session: AsyncSession = Depends(get_session),
) -> tuple[uuid.UUID, uuid.UUID, AsyncSession]:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    try:
        payload = jwt.decode(credentials.credentials, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        vault_id = uuid.UUID(payload["sub"])
        device_id = uuid.UUID(payload["device_id"])
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from exc
    device = await session.get(Device, device_id)
    if device is None or device.vault_id != vault_id or device.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Device is not active")
    device.last_seen = datetime.now(UTC)
    return vault_id, device_id, session


async def verify_hermes_key(
    x_api_key: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    if not x_api_key or x_api_key != settings.hermes_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Hermes API key")
