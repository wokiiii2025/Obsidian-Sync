from dataclasses import dataclass
import os


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _csv_env(name: str) -> set[str]:
    value = os.getenv(name, "")
    return {item.strip() for item in value.split(",") if item.strip()}


@dataclass(frozen=True)
class Settings:
    telegram_bot_token: str
    telegram_webhook_secret: str
    telegram_allowed_chat_ids: set[str]
    telegram_reply_on_queue: bool
    telegram_delete_after_queue: bool
    sync_api_url: str
    hermes_api_key: str
    vault_id: str
    target_note_path: str
    max_text_length: int


def get_settings() -> Settings:
    return Settings(
        telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", ""),
        telegram_webhook_secret=os.getenv("TELEGRAM_WEBHOOK_SECRET", ""),
        telegram_allowed_chat_ids=_csv_env("TELEGRAM_ALLOWED_CHAT_IDS"),
        telegram_reply_on_queue=_bool_env("TELEGRAM_REPLY_ON_QUEUE", True),
        telegram_delete_after_queue=_bool_env("TELEGRAM_DELETE_AFTER_QUEUE", False),
        sync_api_url=os.getenv("SYNC_API_URL", "http://sync-api:8000").rstrip("/"),
        hermes_api_key=os.getenv("HERMES_API_KEY", ""),
        vault_id=os.getenv("TELEGRAM_VAULT_ID", ""),
        target_note_path=os.getenv("TELEGRAM_TARGET_NOTE_PATH", "Inbox/Telegram.md"),
        max_text_length=int(os.getenv("TELEGRAM_MAX_TEXT_LENGTH", "12000")),
    )
