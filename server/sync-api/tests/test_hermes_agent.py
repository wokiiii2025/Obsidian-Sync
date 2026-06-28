from types import SimpleNamespace

from app.hermes_agent import (
    HermesNoteIndex,
    compact_readme_points,
    decrypt_bytes,
    derive_kek,
    encrypt_file,
    github_project_title,
    github_repo_from_text,
    github_usefulness_note,
    path_hash,
    route_item,
)


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
        hermes_agent_github_project_folder="30-开发项目/Git开源项目",
        hermes_agent_inbox_path="Inbox/Telegram.md",
    )
    item = SimpleNamespace(target_note_path="Inbox/Telegram.md", source_type="text")

    decision = route_item(settings, item, "OpenAI agent workflow note", [])

    assert decision.action == "create_new"
    assert decision.target_path.startswith("AI/")


def test_github_repo_from_text() -> None:
    assert github_repo_from_text("https://github.com/physics-dimension/PriceAI") == ("physics-dimension", "PriceAI")
    assert github_project_title("### GitHub 项目：PriceAI\n") == "PriceAI"
    assert github_project_title("### GitHub 项目分析：PriceAI\n") == "PriceAI"


def test_github_project_creates_project_note_in_related_folder() -> None:
    settings = SimpleNamespace(
        hermes_agent_routing_rules="ai, chatgpt, api => AI",
        hermes_agent_append_score_threshold=6,
        hermes_agent_create_folder="Inbox/Hermes",
        hermes_agent_github_project_folder="30-开发项目/Git开源项目",
        hermes_agent_inbox_path="Inbox/Telegram.md",
        hermes_agent_exclusions="90-密钥凭证/**",
    )
    item = SimpleNamespace(target_note_path="Inbox/Telegram.md", source_type="url")
    existing = HermesNoteIndex(
        path="10-AI工具与Agent/模型与网关/大模型.md",
        title="大模型",
        headings=["模型 API"],
        tags=[],
        text="ChatGPT Claude Gemini API",
        note=None,
        content="",
    )

    decision = route_item(settings, item, "### GitHub 项目分析：PriceAI\n\nChatGPT Claude API 比价", [existing])

    assert decision.action == "create_new"
    assert decision.target_path == "30-开发项目/Git开源项目/PriceAI.md"


def test_github_summary_helpers_are_concise() -> None:
    note = github_usefulness_note("AI subscription price tracker", "", ["ai", "price"], "TypeScript")
    points = compact_readme_points("# PriceAI\n\nAI 订阅卡网渠道比价工具，聚合多个渠道报价。\n\n## 部署\n\n使用 Next.js。", 2)

    assert note == "价格/比价/金融数据方向，适合作为开源项目卡片跟踪。"
    assert points == ["PriceAI", "AI 订阅卡网渠道比价工具，聚合多个渠道报价。"]
