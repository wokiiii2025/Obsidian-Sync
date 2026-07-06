import uuid
from datetime import UTC, datetime

from app.main import _deduplicate_active_devices
from app.models import Device
from app.schemas import ChangesResponse, LoginRequest
from app.sync import VectorOrder, compare_vectors


def test_compare_vectors_equal() -> None:
    assert compare_vectors({"a": 1}, {"a": 1}) is VectorOrder.EQUAL


def test_compare_vectors_after() -> None:
    assert compare_vectors({"a": 2, "b": 1}, {"a": 1}) is VectorOrder.AFTER


def test_compare_vectors_before() -> None:
    assert compare_vectors({"a": 1}, {"a": 2, "b": 1}) is VectorOrder.BEFORE


def test_compare_vectors_concurrent() -> None:
    assert compare_vectors({"a": 2, "b": 1}, {"a": 1, "b": 2}) is VectorOrder.CONCURRENT


def test_login_request_accepts_stable_client_instance_id() -> None:
    payload = LoginRequest(
        vault_id=uuid.uuid4(),
        password="secret",
        device_name="Vault - macOS",
        platform="macOS",
        client_instance_id="client-installation-id",
    )

    assert payload.client_instance_id == "client-installation-id"


def test_changes_response_exposes_checkpoint_cursor() -> None:
    checkpoint = datetime(2026, 7, 7, tzinfo=UTC)
    response = ChangesResponse(changes=[], next_cursor=None, has_more=False, checkpoint=checkpoint)

    assert response.checkpoint == checkpoint
    assert response.has_more is False


def test_deduplicate_active_devices_keeps_newest_visible_identity() -> None:
    vault_id = uuid.uuid4()
    newer = Device(
        id=uuid.uuid4(),
        vault_id=vault_id,
        device_name="My-Obsidian - macOS",
        platform="macOS",
        last_seen=datetime(2026, 7, 7, tzinfo=UTC),
        revoked_at=None,
        created_at=datetime(2026, 7, 7, tzinfo=UTC),
    )
    older = Device(
        id=uuid.uuid4(),
        vault_id=vault_id,
        device_name="My-Obsidian - macOS",
        platform="macOS",
        last_seen=datetime(2026, 7, 6, tzinfo=UTC),
        revoked_at=None,
        created_at=datetime(2026, 7, 6, tzinfo=UTC),
    )
    revoked = Device(
        id=uuid.uuid4(),
        vault_id=vault_id,
        device_name="My-Obsidian - iOS",
        platform="iOS",
        last_seen=datetime(2026, 7, 6, tzinfo=UTC),
        revoked_at=datetime(2026, 7, 7, tzinfo=UTC),
        created_at=datetime(2026, 7, 6, tzinfo=UTC),
    )

    assert _deduplicate_active_devices([newer, older, revoked]) == [newer]


def test_deduplicate_active_devices_prefers_current_device() -> None:
    vault_id = uuid.uuid4()
    current = Device(
        id=uuid.uuid4(),
        vault_id=vault_id,
        device_name="My-Obsidian - macOS",
        platform="macOS",
        last_seen=datetime(2026, 7, 6, tzinfo=UTC),
        revoked_at=None,
        created_at=datetime(2026, 7, 6, tzinfo=UTC),
    )
    newer_duplicate = Device(
        id=uuid.uuid4(),
        vault_id=vault_id,
        device_name="My-Obsidian - macOS",
        platform="macOS",
        last_seen=datetime(2026, 7, 7, tzinfo=UTC),
        revoked_at=None,
        created_at=datetime(2026, 7, 7, tzinfo=UTC),
    )

    assert _deduplicate_active_devices([newer_duplicate, current], current.id) == [current]
