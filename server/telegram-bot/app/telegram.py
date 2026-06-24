from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any


@dataclass(frozen=True)
class TelegramAttachment:
    kind: str
    file_id: str
    file_name: str | None = None
    mime_type: str | None = None


@dataclass(frozen=True)
class TelegramIntake:
    chat_id: str
    chat_title: str
    message_id: int
    message_date: datetime
    sender: str
    text: str
    source_type: str
    source_url: str | None
    attachments: list[TelegramAttachment]
    raw_message: dict[str, Any]


def parse_update(update: dict[str, Any], max_text_length: int) -> TelegramIntake | None:
    message = update.get("message") or update.get("channel_post")
    if not isinstance(message, dict):
        return None

    chat = message.get("chat") or {}
    chat_id = str(chat.get("id", ""))
    if not chat_id:
        return None

    text = str(message.get("text") or message.get("caption") or "").strip()
    if len(text) > max_text_length:
        text = f"{text[:max_text_length]}\n\n...[truncated]"

    attachments = extract_attachments(message)
    source_type = classify_source(text, attachments)
    return TelegramIntake(
        chat_id=chat_id,
        chat_title=str(chat.get("title") or chat.get("username") or chat_id),
        message_id=int(message.get("message_id", 0)),
        message_date=datetime.fromtimestamp(int(message.get("date", 0)), tz=UTC) if message.get("date") else datetime.now(UTC),
        sender=sender_name(message),
        text=text,
        source_type=source_type,
        source_url=message_url(chat, int(message.get("message_id", 0))),
        attachments=attachments,
        raw_message=message,
    )


def extract_attachments(message: dict[str, Any]) -> list[TelegramAttachment]:
    attachments: list[TelegramAttachment] = []
    document = message.get("document")
    if isinstance(document, dict):
        attachments.append(TelegramAttachment("document", str(document.get("file_id", "")), document.get("file_name"), document.get("mime_type")))

    for kind in ("video", "audio", "voice", "animation", "sticker"):
        item = message.get(kind)
        if isinstance(item, dict):
            attachments.append(TelegramAttachment(kind, str(item.get("file_id", "")), item.get("file_name"), item.get("mime_type")))

    photos = message.get("photo")
    if isinstance(photos, list) and photos:
        largest = photos[-1]
        if isinstance(largest, dict):
            attachments.append(TelegramAttachment("photo", str(largest.get("file_id", ""))))

    return [item for item in attachments if item.file_id]


def classify_source(text: str, attachments: list[TelegramAttachment]) -> str:
    lowered = text.lower()
    if any(item.kind in {"video", "animation"} for item in attachments):
        return "video"
    if any(item.kind in {"audio", "voice"} for item in attachments):
        return "audio"
    if any(item.kind in {"photo", "document"} for item in attachments):
        return "attachment"
    if "youtube.com/" in lowered or "youtu.be/" in lowered:
        return "youtube"
    if "http://" in lowered or "https://" in lowered:
        return "url"
    return "text"


def sender_name(message: dict[str, Any]) -> str:
    sender = message.get("from") or message.get("sender_chat") or {}
    if not isinstance(sender, dict):
        return "unknown"
    username = sender.get("username")
    if username:
        return f"@{username}"
    parts = [sender.get("first_name"), sender.get("last_name")]
    name = " ".join(str(part) for part in parts if part)
    return name or str(sender.get("title") or sender.get("id") or "unknown")


def message_url(chat: dict[str, Any], message_id: int) -> str | None:
    username = chat.get("username")
    if username and message_id:
        return f"https://t.me/{username}/{message_id}"
    return None


def to_markdown(intake: TelegramIntake) -> str:
    lines = [
        f"### Telegram {intake.source_type}",
        f"> 来源: {intake.chat_title}",
        f"> 消息 ID: {intake.chat_id}/{intake.message_id}",
        f"> 发送者: {intake.sender}",
        f"> 采集日期: {intake.message_date.isoformat()}",
    ]
    if intake.source_url:
        lines.append(f"> 链接: {intake.source_url}")
    if intake.attachments:
        attachment_text = ", ".join(
            f"{item.kind}:{item.file_name or item.file_id}" for item in intake.attachments
        )
        lines.append(f"> 附件: {attachment_text}")
    lines.append("")
    lines.append(intake.text or "[无文字内容]")
    return "\n".join(lines).strip()
