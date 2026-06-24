from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, status
from pydantic import BaseModel

from app.config import get_settings
from app.sync_api import SyncApiClient
from app.telegram import parse_update

app = FastAPI(title="Obsidian Telegram Intake", version="0.1.0")


class HealthResponse(BaseModel):
    status: str


class WebhookResponse(BaseModel):
    ok: bool
    queued: bool = False
    queue_id: int | None = None
    ignored: str | None = None


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/telegram/webhook/{secret}", response_model=WebhookResponse)
async def telegram_webhook(
    secret: str,
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
) -> WebhookResponse:
    settings = get_settings()
    if not settings.telegram_webhook_secret or secret != settings.telegram_webhook_secret:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if x_telegram_bot_api_secret_token and x_telegram_bot_api_secret_token != settings.telegram_webhook_secret:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid Telegram secret")

    update = await request.json()
    intake = parse_update(update, settings.max_text_length)
    if intake is None:
        return WebhookResponse(ok=True, ignored="unsupported_update")
    if settings.telegram_allowed_chat_ids and intake.chat_id not in settings.telegram_allowed_chat_ids:
        return WebhookResponse(ok=True, ignored="chat_not_allowed")

    queue_id = await SyncApiClient(settings).enqueue(intake)
    if settings.telegram_reply_on_queue:
        await telegram_api(settings.telegram_bot_token, "sendMessage", {
            "chat_id": intake.chat_id,
            "reply_to_message_id": intake.message_id,
            "text": f"已加入 Obsidian 队列 #{queue_id}",
            "disable_notification": True,
        })
    if settings.telegram_delete_after_queue:
        await telegram_api(settings.telegram_bot_token, "deleteMessage", {
            "chat_id": intake.chat_id,
            "message_id": intake.message_id,
        })
    return WebhookResponse(ok=True, queued=True, queue_id=queue_id)


async def telegram_api(token: str, method: str, payload: dict[str, Any]) -> None:
    if not token:
        return
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(f"https://api.telegram.org/bot{token}/{method}", json=payload)
        response.raise_for_status()
