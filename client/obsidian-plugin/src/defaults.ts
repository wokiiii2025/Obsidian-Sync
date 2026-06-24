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
  lastOrphanScanAt: "",
  orphanAttachments: [],
  conflictMode: "auto",
  exclusions: ".obsidian/**\n.obsidian-syncignore",
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
  syncHistory: []
};

export const DEFAULT_STATE: SyncState = {
  notes: {}
};

export const STATE_FILE = ".obsidian/zero-knowledge-sync-state.json";
export const CONFLICT_DIR = ".obsidian-conflicts";
