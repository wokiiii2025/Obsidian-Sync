from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://syncuser:change-me@localhost:5432/obsidian_sync"
    jwt_secret: str = "change-me"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 30
    hermes_api_key: str = "change-me"
    hermes_agent_enabled: bool = False
    hermes_agent_vault_id: str = ""
    hermes_agent_vault_password: str = ""
    hermes_agent_interval_seconds: int = 60
    hermes_agent_create_folder: str = "Inbox/Hermes"
    hermes_agent_inbox_path: str = "Inbox/Telegram.md"
    hermes_agent_append_score_threshold: int = 6
    hermes_agent_exclusions: str = "90-密钥凭证/**\n.obsidian/**\n.obsidian-conflicts/**"
    hermes_agent_routing_rules: str = "\n".join(
        [
            "ai, openai, chatgpt, llm, agent, 人工智能, 大模型, 智能体 => AI",
            "server, docker, nginx, postgres, linux, vps, 服务器, 部署, 数据库 => 技术/服务器",
            "obsidian, markdown, 笔记, 知识库, 同步 => Obsidian",
            "telegram, bot, channel, 频道, 机器人 => Telegram",
            "finance, stock, crypto, btc, eth, 投资, 股票, 加密货币 => 投资",
            "read, book, article, paper, 阅读, 文章, 论文, 资料 => 阅读",
        ]
    )

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


@lru_cache
def get_settings() -> Settings:
    return Settings()
