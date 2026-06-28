import type { PluginSettings, SyncState } from "./types";

export const DEFAULT_SETTINGS: PluginSettings = {
  language: "en",
  serverUrl: "http://127.0.0.1:8080",
  vaultId: "",
  deviceId: "",
  token: "",
  syncMode: "manual",
  syncIntervalSeconds: 30,
  autoSyncOnChange: true,
  autoSyncDebounceSeconds: 60,
  hermesAgentEnabled: true,
  hermesAgentIntervalSeconds: 60,
  hermesAgentInboxPath: "Inbox/Telegram.md",
  hermesAgentCreateFolder: "Inbox/Hermes",
  hermesAgentRoutingRules: [
    "ai, openai, chatgpt, llm, agent, 人工智能, 大模型, 智能体 => AI",
    "server, docker, nginx, postgres, linux, vps, 服务器, 部署, 数据库 => 技术/服务器",
    "obsidian, markdown, 笔记, 知识库, 同步 => Obsidian",
    "telegram, bot, channel, 频道, 机器人 => Telegram",
    "finance, stock, crypto, btc, eth, 投资, 股票, 加密货币 => 投资",
    "read, book, article, paper, 阅读, 文章, 论文, 资料 => 阅读"
  ].join("\n"),
  hermesAgentAppendScoreThreshold: 6,
  syncMarkdown: true,
  syncJson: true,
  syncImages: true,
  syncDocuments: true,
  syncAudio: true,
  syncVideo: true,
  syncArchives: true,
  syncOtherFiles: true,
  manageAttachments: true,
  attachmentFolder: "Attachments",
  attachmentOrganizationMode: "type-date",
  attachmentDateFormat: "YYYY/MM/DD",
  attachmentTypeMappings: [
    "images: png, jpg, jpeg, gif, webp, svg, bmp, avif",
    "documents: pdf, doc, docx, ppt, pptx, xls, xlsx, csv",
    "audio: mp3, wav, m4a, flac, ogg, aac",
    "video: mp4, mov, mkv, webm, avi",
    "archives: zip, rar, 7z, tar, gz"
  ].join("\n"),
  attachmentMigrationPrompted: false,
  lastAttachmentMigrationAt: "",
  lastOrphanScanAt: "",
  lastAttachmentCleanupAt: "",
  orphanAttachments: [],
  conflictMode: "auto",
  exclusions: ".obsidian/plugins/obsidian-zero-knowledge-sync/data.json\n.obsidian/zero-knowledge-sync-state.json\n.obsidian-syncignore",
  lastSync: "",
  lastSyncStatus: "idle",
  lastSyncStats: {
    trackedNotes: 0,
    downloaded: 0,
    uploaded: 0,
    conflicts: 0,
    lastStartedAt: "",
    lastFinishedAt: "",
    lastError: ""
  },
  syncHistory: [],
  conflictRecords: []
};

export const DEFAULT_STATE: SyncState = {
  notes: {}
};

export const STATE_FILE = ".obsidian/zero-knowledge-sync-state.json";
export const CONFLICT_DIR = ".obsidian-conflicts";
export const LEGACY_DEFAULT_EXCLUSIONS = ".obsidian/**\n.obsidian-syncignore";
export const PROTECTED_EXCLUSIONS = [
  ".obsidian/plugins/obsidian-zero-knowledge-sync/data.json",
  STATE_FILE
];
