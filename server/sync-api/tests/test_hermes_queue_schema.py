from datetime import UTC, datetime

from app.schemas import HermesQueueCompleteResponse, HermesQueueItem, HermesQueueResponse


def test_hermes_queue_response_schema() -> None:
    item = HermesQueueItem(
        id=1,
        target_note_path="Inbox/Telegram.md",
        merge_content="hello",
        source_url=None,
        source_type="text",
        status="pending",
        created_at=datetime(2026, 6, 28, tzinfo=UTC),
    )

    response = HermesQueueResponse(items=[item])

    assert response.items[0].target_note_path == "Inbox/Telegram.md"
    assert response.items[0].status == "pending"


def test_hermes_queue_complete_response_schema() -> None:
    assert HermesQueueCompleteResponse(status="merged").status == "merged"
