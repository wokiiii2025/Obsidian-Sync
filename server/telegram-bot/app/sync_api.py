import httpx

from app.config import Settings
from app.telegram import TelegramIntake, to_markdown


class SyncApiClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def enqueue(self, intake: TelegramIntake) -> int:
        if not self.settings.vault_id:
            raise RuntimeError("TELEGRAM_VAULT_ID is not configured")
        if not self.settings.hermes_api_key:
            raise RuntimeError("HERMES_API_KEY is not configured")
        payload = {
            "vault_id": self.settings.vault_id,
            "note_path": self.settings.target_note_path,
            "merge_content": to_markdown(intake),
            "source_url": intake.source_url,
            "source_type": intake.source_type,
        }
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                f"{self.settings.sync_api_url}/api/v1/hermes/merge",
                json=payload,
                headers={"X-API-Key": self.settings.hermes_api_key},
            )
            response.raise_for_status()
            data = response.json()
            return int(data["queue_id"])
