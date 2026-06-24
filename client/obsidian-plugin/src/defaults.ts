import type { PluginSettings, SyncState } from "./types";

export const DEFAULT_SETTINGS: PluginSettings = {
  language: "en",
  serverUrl: "http://127.0.0.1:8080",
  vaultId: "",
  deviceId: "",
  token: "",
  syncMode: "manual",
  syncIntervalSeconds: 30,
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
  }
};

export const DEFAULT_STATE: SyncState = {
  notes: {}
};

export const STATE_FILE = ".obsidian/zero-knowledge-sync-state.json";
export const CONFLICT_DIR = ".obsidian-conflicts";
