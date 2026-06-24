from app.telegram import parse_update, to_markdown


def test_parse_text_update() -> None:
    update = {
        "message": {
            "message_id": 7,
            "date": 1710000000,
            "chat": {"id": -1001, "title": "Inbox"},
            "from": {"username": "alice"},
            "text": "hello obsidian",
        }
    }
    intake = parse_update(update, 1000)
    assert intake is not None
    assert intake.chat_id == "-1001"
    assert intake.sender == "@alice"
    assert intake.source_type == "text"
    assert "hello obsidian" in to_markdown(intake)


def test_parse_url_update() -> None:
    update = {
        "channel_post": {
            "message_id": 8,
            "date": 1710000000,
            "chat": {"id": -1002, "title": "Links", "username": "links"},
            "text": "https://example.com/article",
        }
    }
    intake = parse_update(update, 1000)
    assert intake is not None
    assert intake.source_type == "url"
    assert intake.source_url == "https://t.me/links/8"


def test_parse_photo_caption() -> None:
    update = {
        "message": {
            "message_id": 9,
            "date": 1710000000,
            "chat": {"id": -1003, "title": "Images"},
            "caption": "diagram",
            "photo": [{"file_id": "small"}, {"file_id": "large"}],
        }
    }
    intake = parse_update(update, 1000)
    assert intake is not None
    assert intake.source_type == "attachment"
    assert intake.attachments[0].file_id == "large"
    assert "photo:large" in to_markdown(intake)
