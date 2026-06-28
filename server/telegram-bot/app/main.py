import asyncio
from contextlib import suppress
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, status
from pydantic import BaseModel

from app.config import get_settings
from app.sync_api import SyncApiClient
from app.telegram import parse_update

app = FastAPI(title="Obsidian Telegram Intake", version="0.1.0")
polling_task: asyncio.Task | None = None


class HealthResponse(BaseModel):
    status: str


class WebhookResponse(BaseModel):
    ok: bool
    queued: bool = False
    queue_id: int | None = None
    ignored: str | None = None


@app.on_event("startup")
async def startup() -> None:
    global polling_task
    settings = get_settings()
    if settings.telegram_polling_enabled and settings.telegram_bot_token:
        polling_task = asyncio.create_task(poll_telegram_updates())


@app.on_event("shutdown")
async def shutdown() -> None:
    if polling_task:
        polling_task.cancel()
        with suppress(asyncio.CancelledError):
            await polling_task


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

    return await handle_update(await request.json())


async def handle_update(update: dict[str, Any]) -> WebhookResponse:
    settings = get_settings()
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


async def poll_telegram_updates() -> None:
    settings = get_settings()
    offset = 0
    await telegram_api(settings.telegram_bot_token, "deleteWebhook", {"drop_pending_updates": settings.telegram_skip_pending_on_start})
    if settings.telegram_skip_pending_on_start:
        offset = await latest_update_offset(settings.telegram_bot_token)
    while True:
        try:
            data = await telegram_api_json(settings.telegram_bot_token, "getUpdates", {
                "offset": offset,
                "timeout": 25,
                "allowed_updates": ["message", "channel_post"],
            })
            for update in data.get("result", []):
                update_id = int(update.get("update_id", 0))
                offset = max(offset, update_id + 1)
                await handle_update(update)
        except Exception:
            await asyncio.sleep(max(1, settings.telegram_polling_interval_seconds))


async def latest_update_offset(token: str) -> int:
    data = await telegram_api_json(token, "getUpdates", {"timeout": 0, "limit": 1, "offset": -1})
    result = data.get("result", [])
    if not result:
        return 0
    return int(result[-1].get("update_id", 0)) + 1


async def telegram_api(token: str, method: str, payload: dict[str, Any]) -> None:
    await telegram_api_json(token, method, payload)


async def telegram_api_json(token: str, method: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not token:
        return {}
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(f"https://api.telegram.org/bot{token}/{method}", json=payload)
        response.raise_for_status()
        return response.json()
