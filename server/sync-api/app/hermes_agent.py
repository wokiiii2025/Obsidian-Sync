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
    index: list[HermesNoteIndex] = []
    for note in notes:
        path, content = decrypt_note(kek, note)
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
