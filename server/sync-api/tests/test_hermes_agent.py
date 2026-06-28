from types import SimpleNamespace

from app.hermes_agent import decrypt_bytes, derive_kek, encrypt_file, path_hash, route_item


def test_hermes_agent_encryption_roundtrip() -> None:
    kek = derive_kek("test-password")
    encrypted = encrypt_file(kek, "Inbox/Test.md", b"hello")

    assert encrypted["path_hash"] == path_hash("Inbox/Test.md")
    assert decrypt_bytes(kek, encrypted["dek_encrypted"])


def test_hermes_agent_routes_new_note_by_rule() -> None:
    settings = SimpleNamespace(
        hermes_agent_routing_rules="openai, ai => AI",
        hermes_agent_append_score_threshold=6,
        hermes_agent_create_folder="Inbox/Hermes",
        hermes_agent_inbox_path="Inbox/Telegram.md",
    )
    item = SimpleNamespace(target_note_path="Inbox/Telegram.md", source_type="text")

    decision = route_item(settings, item, "OpenAI agent workflow note", [])

    assert decision.action == "create_new"
    assert decision.target_path.startswith("AI/")
