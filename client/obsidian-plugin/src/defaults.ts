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
  lastSync: ""
};

export const DEFAULT_STATE: SyncState = {
  notes: {}
};

export const STATE_FILE = ".obsidian/zero-knowledge-sync-state.json";
export const CONFLICT_DIR = ".obsidian-conflicts";
