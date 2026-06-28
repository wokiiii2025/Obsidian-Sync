import asyncio
import base64
import hashlib
import logging
import os
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Iterable

import httpx
from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.models import Device, HermesQueue, Note, NoteVersion, SyncLog, Vault

NONCE_LENGTH = 12
KEY_LENGTH = 32
KDF_SALT = b"obsidian-zero-knowledge-sync-v1"
logger = logging.getLogger("hermes-agent")
DEFAULT_ROUTING_RULES = "\n".join(
    [
        "ai, openai, chatgpt, llm, agent, 人工智能, 大模型, 智能体 => AI",
        "server, docker, nginx, postgres, linux, vps, 服务器, 部署, 数据库 => 技术/服务器",
        "obsidian, markdown, 笔记, 知识库, 同步 => Obsidian",
        "telegram, bot, channel, 频道, 机器人 => Telegram",
        "finance, stock, crypto, btc, eth, 投资, 股票, 加密货币 => 投资",
        "read, book, article, paper, 阅读, 文章, 论文, 资料 => 阅读",
    ]
)


@dataclass
class HermesNoteIndex:
    path: str
    title: str
    headings: list[str]
    tags: list[str]
    text: str
    note: Note
    content: str


@dataclass
class HermesRoutingRule:
    keywords: list[str]
    target_folder: str


@dataclass
class HermesRouteDecision:
    action: str
    target_path: str
    title: str
    heading: str
    content: str
    reason: str
    existing_note: Note | None = None
    existing_content: str | None = None


async def run_hermes_agent_loop(settings: Settings, session_factory: async_sessionmaker[AsyncSession]) -> None:
    if not settings.hermes_agent_enabled:
        return
    if not settings.hermes_agent_vault_id or not settings.hermes_agent_vault_password:
        logger.warning("Hermes Agent is enabled but vault id or password is missing.")
        return

    interval = max(10, settings.hermes_agent_interval_seconds)
    logger.info("Hermes Agent started for vault %s with interval %ss.", settings.hermes_agent_vault_id, interval)
    while True:
        try:
            async with session_factory() as session:
                processed = await process_pending_hermes_items(settings, session)
                if processed:
                    logger.info("Hermes Agent processed %s queue item(s).", processed)
        except Exception:
            logger.exception("Hermes Agent loop failed.")
        await asyncio.sleep(interval)


async def process_pending_hermes_items(settings: Settings, session: AsyncSession) -> int:
    vault_id = uuid.UUID(settings.hermes_agent_vault_id)
    kek = derive_kek(settings.hermes_agent_vault_password)
    vault = await session.get(Vault, vault_id)
    if vault is None:
        return 0

    device = await hermes_device(session, vault_id)
    query = (
        select(HermesQueue)
        .where(HermesQueue.vault_id == vault_id, HermesQueue.status == "pending")
        .order_by(HermesQueue.created_at.asc(), HermesQueue.id.asc())
        .limit(20)
    )
    items = (await session.execute(query)).scalars().all()
    processed = 0
    for item in items:
        try:
            content = (item.merge_content or "").strip()
            if not content:
                item.status = "merged"
                item.merged_at = datetime.now(UTC)
                processed += 1
                continue
            content = await enrich_hermes_content(content)
            index = await build_vault_index(session, vault_id, kek)
            decision = route_item(settings, item, content, index)
            await apply_decision(session, vault_id, device.id, kek, decision)
            item.status = "merged"
            item.merged_at = datetime.now(UTC)
            item.error_message = None
            processed += 1
            logger.info("Hermes queue item %s merged into %s.", item.id, decision.target_path)
        except Exception as exc:
            item.status = "failed"
            item.error_message = str(exc)[:1000]
            logger.exception("Hermes queue item %s failed.", item.id)
    await session.commit()
    return processed


async def hermes_device(session: AsyncSession, vault_id: uuid.UUID) -> Device:
    query = select(Device).where(Device.vault_id == vault_id, Device.platform == "hermes-agent", Device.revoked_at.is_(None)).limit(1)
    device = (await session.execute(query)).scalar_one_or_none()
    if device is not None:
        device.last_seen = datetime.now(UTC)
        return device
    device = Device(vault_id=vault_id, device_name="Hermes Agent", platform="hermes-agent", last_seen=datetime.now(UTC))
    session.add(device)
    await session.flush()
    return device


async def build_vault_index(session: AsyncSession, vault_id: uuid.UUID, kek: bytes) -> list[HermesNoteIndex]:
    query = select(Note).where(Note.vault_id == vault_id, Note.deleted_at.is_(None), Note.mime_type == "text/markdown")
    notes = (await session.execute(query)).scalars().all()
    settings = Settings()
    index: list[HermesNoteIndex] = []
    for note in notes:
        path, content = decrypt_note(kek, note)
        if is_excluded_path(path, settings.hermes_agent_exclusions):
            continue
        index.append(
            HermesNoteIndex(
                path=path,
                title=note_title(path, content),
                headings=extract_headings(content),
                tags=extract_tags(content),
                text=f"{path}\n{content[:4000]}",
                note=note,
                content=content,
            )
        )
    return index


def route_item(settings: Settings, item: HermesQueue, content: str, index: list[HermesNoteIndex]) -> HermesRouteDecision:
    rules = parse_routing_rules(settings.hermes_agent_routing_rules or DEFAULT_ROUTING_RULES)
    rule = best_rule(content, rules)
    candidates = score_candidates(content, index, rule.keywords if rule else [])
    best = candidates[0] if candidates else None
    threshold = max(1, settings.hermes_agent_append_score_threshold)
    project_title = github_project_title(content)
    if project_title:
        title_lower = project_title.lower()
        if best and (title_lower in best[1].path.lower() or title_lower in best[1].title.lower()):
            note = best[1]
            return HermesRouteDecision(
                action="append_existing",
                target_path=note.path,
                title=note.title,
                heading=best[2] or "Hermes",
                content=content,
                reason=f"Matched existing project note with score {best[0]}.",
                existing_note=note.note,
                existing_content=note.content,
            )
        target_folder = normalize_path(settings.hermes_agent_github_project_folder)
        return HermesRouteDecision(
            action="create_new",
            target_path=unique_markdown_path(f"{target_folder}/{project_title}.md", [entry.path for entry in index]),
            title=project_title,
            heading="Hermes",
            content=content,
            reason="GitHub project captured into open-source project library.",
        )
    if best and best[0] >= threshold:
        note = best[1]
        return HermesRouteDecision(
            action="append_existing",
            target_path=note.path,
            title=note.title,
            heading=best[2] or "Hermes",
            content=content,
            reason=f"Matched existing note with score {best[0]}.",
            existing_note=note.note,
            existing_content=note.content,
        )
    fallback_path = normalize_path(item.target_note_path or settings.hermes_agent_inbox_path)
    target_folder = (rule.target_folder if rule else "") or normalize_path(settings.hermes_agent_create_folder) or parent_folder(fallback_path)
    title = hermes_title(content, item.source_type or "Telegram")
    return HermesRouteDecision(
        action="create_new",
        target_path=unique_markdown_path(f"{target_folder}/{title}.md", [entry.path for entry in index]),
        title=title,
        heading="Hermes",
        content=content,
        reason=f"Matched route: {rule.target_folder}." if rule else "No strong existing-note match.",
    )


async def apply_decision(session: AsyncSession, vault_id: uuid.UUID, device_id: uuid.UUID, kek: bytes, decision: HermesRouteDecision) -> None:
    now = datetime.now(UTC)
    if decision.existing_note is not None and decision.existing_content is not None:
        note = decision.existing_note
        next_content = append_hermes_block(decision.existing_content, decision.content, decision.heading)
        operation = "update"
    else:
        note = Note(vault_id=vault_id, path_hash=path_hash(decision.target_path), version_vector={})
        session.add(note)
        next_content = create_hermes_note(decision.title, decision.content, decision.reason)
        operation = "create"

    encrypted = encrypt_file(kek, decision.target_path, next_content.encode("utf-8"))
    vector = dict(note.version_vector or {})
    vector[str(device_id)] = int(vector.get(str(device_id), 0)) + 1
    note.path_hash = encrypted["path_hash"]
    note.path_encrypted = encrypted["path_encrypted"]
    note.content_encrypted = encrypted["content_encrypted"]
    note.dek_encrypted = encrypted["dek_encrypted"]
    note.version_vector = vector
    note.file_size = len(next_content.encode("utf-8"))
    note.mime_type = "text/markdown"
    note.deleted_at = None
    note.modified_at = now
    await session.flush()

    session.add(
        NoteVersion(
            vault_id=vault_id,
            note_id=note.id,
            device_id=device_id,
            operation=operation,
            path_hash=note.path_hash,
            path_encrypted=note.path_encrypted,
            content_encrypted=note.content_encrypted,
            dek_encrypted=note.dek_encrypted,
            version_vector=note.version_vector,
            file_size=note.file_size,
            mime_type=note.mime_type,
        )
    )
    session.add(
        SyncLog(
            vault_id=vault_id,
            note_id=note.id,
            device_id=device_id,
            operation=operation,
            path_hash=note.path_hash,
            version_vector=note.version_vector,
        )
    )


def derive_kek(password: str) -> bytes:
    return hash_secret_raw(
        password.encode("utf-8"),
        KDF_SALT,
        time_cost=3,
        memory_cost=65536,
        parallelism=4,
        hash_len=KEY_LENGTH,
        type=Type.ID,
    )


def path_hash(path: str) -> str:
    return base64.b64encode(hashlib.sha256(path.encode("utf-8")).digest()).decode("ascii")


def encrypt_file(kek: bytes, path: str, content: bytes) -> dict[str, bytes | str]:
    dek = os.urandom(KEY_LENGTH)
    hashed = path_hash(path)
    aad = hashed.encode("utf-8")
    return {
        "path_hash": hashed,
        "path_encrypted": encrypt_bytes(dek, path.encode("utf-8"), aad),
        "content_encrypted": encrypt_bytes(dek, content, aad),
        "dek_encrypted": encrypt_bytes(kek, dek),
    }


def encrypt_bytes(key: bytes, plaintext: bytes, aad: bytes | None = None) -> bytes:
    nonce = os.urandom(NONCE_LENGTH)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def decrypt_note(kek: bytes, note: Note) -> tuple[str, str]:
    dek = decrypt_bytes(kek, note.dek_encrypted)
    aad = note.path_hash.encode("utf-8")
    path = decrypt_bytes(dek, note.path_encrypted, aad).decode("utf-8")
    content = decrypt_bytes(dek, note.content_encrypted, aad).decode("utf-8")
    return path, content


def decrypt_bytes(key: bytes, payload: bytes, aad: bytes | None = None) -> bytes:
    nonce = payload[:NONCE_LENGTH]
    ciphertext = payload[NONCE_LENGTH:]
    return AESGCM(key).decrypt(nonce, ciphertext, aad)


async def enrich_hermes_content(content: str) -> str:
    github_repo = github_repo_from_text(content)
    if github_repo:
        return await enrich_github_repository(content, github_repo[0], github_repo[1])
    return content


def github_repo_from_text(content: str) -> tuple[str, str] | None:
    match = re.search(r"https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)(?:[/?#\s]|$)", content)
    if not match:
        return None
    return match.group(1), match.group(2).removesuffix(".git")


def github_project_title(content: str) -> str:
    match = re.search(r"^### GitHub 项目分析：(.+)$", content, re.MULTILINE)
    if not match:
        return ""
    return sanitize_filename(match.group(1).strip())


def project_target_folder(settings: Settings, rule: HermesRoutingRule | None, best: tuple[int, HermesNoteIndex, str] | None) -> str:
    if best and best[0] >= 3 and not is_excluded_path(best[1].path, settings.hermes_agent_exclusions):
        parent = parent_folder(best[1].path)
        if parent:
            return parent
    if rule and rule.target_folder:
        return rule.target_folder
    return normalize_path(settings.hermes_agent_create_folder)


async def enrich_github_repository(content: str, owner: str, repo: str) -> str:
    repo_url = f"https://github.com/{owner}/{repo}"
    api_url = f"https://api.github.com/repos/{owner}/{repo}"
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "Obsidian-Hermes-Agent"}
    try:
        async with httpx.AsyncClient(timeout=15, headers=headers, follow_redirects=True) as client:
            repo_response = await client.get(api_url)
            repo_response.raise_for_status()
            repo_data = repo_response.json()
            readme_excerpt = await fetch_github_readme_excerpt(client, owner, repo, repo_data.get("default_branch") or "main")
    except Exception as exc:
        logger.warning("GitHub enrichment failed for %s/%s: %s", owner, repo, exc)
        return content

    description = repo_data.get("description") or "未提供描述"
    language = repo_data.get("language") or "未知"
    stars = repo_data.get("stargazers_count") or 0
    forks = repo_data.get("forks_count") or 0
    updated_at = repo_data.get("updated_at") or "未知"
    homepage = repo_data.get("homepage") or ""
    topics = repo_data.get("topics") or []
    archived = "是" if repo_data.get("archived") else "否"
    license_name = (repo_data.get("license") or {}).get("name") or "未声明"
    analysis = github_usefulness_note(description, readme_excerpt, topics, language)
    lines = [
        f"### GitHub 项目分析：{repo}",
        "",
        f"- 仓库：[{owner}/{repo}]({repo_url})",
        f"- 定位：{description}",
        f"- 主要语言：{language}",
        f"- Stars/Forks：{stars} / {forks}",
        f"- 最近更新：{updated_at}",
        f"- License：{license_name}",
        f"- Archived：{archived}",
    ]
    if topics:
        lines.append(f"- Topics：{', '.join(str(topic) for topic in topics[:12])}")
    if homepage:
        lines.append(f"- Homepage：{homepage}")
    lines.extend(
        [
            "",
            "#### 初步判断",
            "",
            analysis,
        ]
    )
    if readme_excerpt:
        lines.extend(
            [
                "",
                "#### README 摘要",
                "",
                readme_excerpt,
            ]
        )
    lines.extend(
        [
            "",
            "#### 原始采集",
            "",
            content.strip(),
        ]
    )
    return "\n".join(lines).strip()


async def fetch_github_readme_excerpt(client: httpx.AsyncClient, owner: str, repo: str, default_branch: str) -> str:
    candidates = [
        f"https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/README.md",
        f"https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/readme.md",
        f"https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/README.rst",
    ]
    for url in candidates:
        response = await client.get(url)
        if response.status_code == 200 and response.text.strip():
            return compact_markdown_excerpt(response.text, 1200)
    return ""


def compact_markdown_excerpt(markdown: str, limit: int) -> str:
    lines = []
    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith(("!", "[![", "<p", "</p>", "<img", "<picture", "<source")):
            continue
        lines.append(stripped)
        if sum(len(item) for item in lines) > limit:
            break
    excerpt = "\n".join(lines)
    return excerpt[:limit].rstrip()


def github_usefulness_note(description: str, readme_excerpt: str, topics: list[str], language: str) -> str:
    text = f"{description}\n{readme_excerpt}\n{' '.join(topics)}".lower()
    points: list[str] = []
    if any(keyword in text for keyword in ["stock", "price", "trading", "finance", "投资", "股票", "价格"]):
        points.append("这是一个偏金融/价格分析方向的项目，适合归入投资、量化或数据分析资料。")
    if any(keyword in text for keyword in ["ai", "agent", "llm", "machine learning", "deep learning", "人工智能", "模型"]):
        points.append("项目包含 AI/模型相关信号，后续可以关注其模型输入、数据来源和预测流程。")
    if any(keyword in text for keyword in ["api", "server", "backend", "fastapi", "web"]):
        points.append("它可能包含可部署服务或 API，适合进一步检查运行方式和接口设计。")
    if language and language != "未知":
        points.append(f"主要语言是 {language}，可优先查看依赖文件、入口文件和 README 的运行说明。")
    if not points:
        points.append("当前只能从仓库元数据做初步判断，建议继续查看 README、示例和最近提交来确认可用性。")
    return "\n".join(f"- {point}" for point in points)


def parse_routing_rules(text: str) -> list[HermesRoutingRule]:
    rules: list[HermesRoutingRule] = []
    for line in text.splitlines():
        if "=>" not in line:
            continue
        keyword_part, target_part = line.split("=>", 1)
        keywords = [part.strip().lower() for part in re.split(r"[,，]", keyword_part) if part.strip()]
        target_folder = normalize_path(target_part.strip())
        if keywords and target_folder:
            rules.append(HermesRoutingRule(keywords=keywords, target_folder=target_folder))
    return rules


def best_rule(content: str, rules: Iterable[HermesRoutingRule]) -> HermesRoutingRule | None:
    lowered = content.lower()
    best: tuple[int, HermesRoutingRule] | None = None
    for rule in rules:
        score = sum(lowered.count(keyword) for keyword in rule.keywords)
        if score > 0 and (best is None or score > best[0]):
            best = (score, rule)
    return best[1] if best else None


def score_candidates(content: str, index: list[HermesNoteIndex], route_keywords: list[str]) -> list[tuple[int, HermesNoteIndex, str]]:
    terms = important_terms(content)
    lowered_content = content.lower()
    scored: list[tuple[int, HermesNoteIndex, str]] = []
    for note in index:
        path_text = note.path.lower()
        title_text = note.title.lower()
        heading_text = " ".join(note.headings).lower()
        tag_text = " ".join(note.tags).lower()
        body_text = note.text.lower()
        score = 0
        for keyword in route_keywords:
            if keyword and (keyword in path_text or keyword in title_text or keyword in tag_text):
                score += 4
        for term in terms:
            if term in title_text:
                score += 5
            if term in path_text:
                score += 3
            if term in tag_text:
                score += 3
            if term in heading_text:
                score += 2
            if term in body_text:
                score += 1
        if score > 0:
            scored.append((score, note, best_heading_for_content(lowered_content, note.headings) or "Hermes"))
    return sorted(scored, key=lambda item: item[0], reverse=True)


def important_terms(content: str) -> list[str]:
    stopwords = {
        "telegram",
        "https",
        "http",
        "www",
        "com",
        "the",
        "and",
        "for",
        "with",
        "from",
        "this",
        "that",
        "来源",
        "消息",
        "发送者",
        "采集日期",
        "链接",
        "附件",
        "文字内容",
    }
    counts: dict[str, int] = {}
    for match in re.findall(r"[\w\u4e00-\u9fff-]{2,}", content.lower()):
        if match in stopwords or match.isdigit() or len(match) > 40:
            continue
        counts[match] = counts.get(match, 0) + 1
    return [term for term, _count in sorted(counts.items(), key=lambda item: item[1], reverse=True)[:18]]


def best_heading_for_content(lowered_content: str, headings: list[str]) -> str:
    best_heading = ""
    best_score = 0
    for heading in headings:
        score = sum(1 for term in important_terms(heading) if term in lowered_content)
        if score > best_score:
            best_heading = heading
            best_score = score
    return best_heading


def append_hermes_block(original: str, content: str, heading: str) -> str:
    block = hermes_block(content)
    pattern = re.compile(rf"(^|\n)(#{{1,6}})\s+{re.escape(heading)}\s*\n", re.IGNORECASE)
    match = pattern.search(original)
    if not match:
        return f"{original.rstrip()}\n\n## {heading}\n\n{block}\n"
    heading_level = len(match.group(2))
    start = match.end()
    next_heading = re.search(rf"\n#{{1,{heading_level}}}\s+", original[start:])
    insert_at = start + next_heading.start() if next_heading else len(original)
    return f"{original[:insert_at].rstrip()}\n\n{block}\n{original[insert_at:]}"


def create_hermes_note(title: str, content: str, reason: str) -> str:
    return "\n".join(
        [
            "---",
            "source: hermes",
            f"created: {datetime.now(UTC).isoformat()}",
            f"route_reason: {reason!r}",
            "---",
            "",
            f"# {title}",
            "",
            hermes_block(content),
            "",
        ]
    )


def hermes_block(content: str) -> str:
    return f"### {datetime.now(UTC).isoformat()}\n\n{content.strip()}"


def hermes_title(content: str, source_type: str) -> str:
    for line in content.splitlines():
        candidate = re.sub(r"^#+\s*", "", line).strip()
        if candidate and not candidate.startswith(">") and "Telegram " not in candidate:
            return sanitize_filename(candidate[:48]) or f"{source_type} {datetime.now(UTC).date().isoformat()}"
    return f"{source_type or 'Telegram'} {datetime.now(UTC).date().isoformat()}"


def sanitize_filename(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"""[\\/:*?"<>|#\^[\]]""", " ", value)).strip()


def note_title(path: str, content: str) -> str:
    match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    if match:
        return match.group(1).strip()
    return path.rsplit("/", 1)[-1].removesuffix(".md")


def extract_headings(content: str) -> list[str]:
    return [match.group(1).strip() for match in re.finditer(r"^#{1,6}\s+(.+)$", content, re.MULTILINE)]


def extract_tags(content: str) -> list[str]:
    tags = set(re.findall(r"(^|\s)#([\w\u4e00-\u9fff/-]+)", content))
    return [tag for _prefix, tag in tags]


def unique_markdown_path(preferred_path: str, existing_paths: list[str]) -> str:
    normalized = normalize_path(preferred_path if preferred_path.endswith(".md") else f"{preferred_path}.md")
    existing = set(existing_paths)
    if normalized not in existing:
        return normalized
    base = normalized[:-3]
    index = 1
    while f"{base}-{index}.md" in existing:
        index += 1
    return f"{base}-{index}.md"


def normalize_path(path: str) -> str:
    return re.sub(r"/+", "/", path.replace("\\", "/").strip("/"))


def parent_folder(path: str) -> str:
    normalized = normalize_path(path)
    return normalized.rsplit("/", 1)[0] if "/" in normalized else ""


def is_excluded_path(path: str, patterns_text: str) -> bool:
    patterns = [normalize_path(line.strip()) for line in patterns_text.splitlines() if line.strip()]
    normalized = normalize_path(path)
    for pattern in patterns:
        if pattern.endswith("/**") and normalized.startswith(pattern[:-3]):
            return True
        if normalized == pattern or normalized.startswith(f"{pattern}/"):
            return True
    return False
