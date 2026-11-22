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
    hermes_agent_github_project_folder: str = "30-开发项目/Git开源项目"
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
    admin_token: str = ""
    admin_backup_enabled: bool = False
    admin_backup_interval_hours: int = 24
    admin_backup_directory: str = "/app/backups"
    admin_backup_keep_local: int = 3
    admin_backup_rclone_remote: str = ""
    admin_backup_rclone_config: str = ""
    admin_backup_timeout_seconds: int = 600
    admin_public_url: str = ""
    admin_google_client_id: str = ""
    admin_google_client_secret: str = ""
    admin_google_redirect_uri: str = ""
    admin_google_token_file: str = "/app/backups/google-drive-token.json"
    admin_google_drive_folder_id: str = ""
    admin_google_drive_folder_name: str = "Obsidian Sync Backups"
    # 维护任务：默认只做"安全回收"，任何会丢数据/断设备的动作都必须显式开启。
    maintenance_enabled: bool = True
    maintenance_interval_hours: int = 24
    # 墓碑回收：软删除超过该天数的笔记硬删除（笔记已被用户删除，属安全回收）。
    maintenance_retention_days: int = 30
    # 版本历史保留条数；0 = 不裁剪（默认，避免删掉用户的版本历史）。
    maintenance_keep_versions: int = 0
    # 同步日志裁剪；默认关闭。开启前提：客户端支持"日志缺口 -> 全量重同步"，
    # 否则离线超过 retention_days 的设备会漏掉删除事件，甚至把已删笔记重新推回。
    maintenance_prune_sync_log: bool = False
    # 自动吊销长期未活动设备的天数；0 = 不自动吊销（默认，避免误杀备用设备）。
    maintenance_revoke_inactive_days: int = 0

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


@lru_cache
def get_settings() -> Settings:
    return Settings()
