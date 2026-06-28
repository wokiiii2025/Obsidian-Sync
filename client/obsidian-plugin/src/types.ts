export type SyncMode = "manual" | "periodic";
export type Language = "en" | "zh";
export type SyncStatus = "idle" | "running" | "success" | "error" | "locked";
export type AttachmentOrganizationMode = "flat" | "type" | "date" | "type-date";

export interface SyncStats {
  trackedNotes: number;
  downloaded: number;
  uploaded: number;
  conflicts: number;
  lastStartedAt: string;
  lastFinishedAt: string;
  lastError: string;
}

export interface SyncHistoryEntry extends SyncStats {
  status: SyncStatus;
}

export interface ConflictRecord {
  originalPath: string;
  conflictPath: string;
  createdAt: string;
}

export interface PluginSettings {
  language: Language;
  serverUrl: string;
  vaultId: string;
  deviceId: string;
  token: string;
  syncMode: SyncMode;
  syncIntervalSeconds: number;
  autoSyncOnChange: boolean;
  autoSyncDebounceSeconds: number;
  syncMarkdown: boolean;
  syncImages: boolean;
  syncDocuments: boolean;
  syncAudio: boolean;
  syncVideo: boolean;
  syncArchives: boolean;
  syncOtherFiles: boolean;
  manageAttachments: boolean;
  attachmentFolder: string;
  attachmentOrganizationMode: AttachmentOrganizationMode;
  attachmentDateFormat: string;
  attachmentTypeMappings: string;
  attachmentMigrationPrompted: boolean;
  lastAttachmentMigrationAt: string;
  lastOrphanScanAt: string;
  lastAttachmentCleanupAt: string;
  orphanAttachments: string[];
  conflictMode: "auto" | "manual";
  exclusions: string;
  lastSync: string;
  lastSyncStatus: SyncStatus;
  lastSyncStats: SyncStats;
  syncHistory: SyncHistoryEntry[];
  conflictRecords: ConflictRecord[];
}

export interface SyncStateEntry {
  pathHash: string;
  versionVector: Record<string, number>;
  modifiedTime: number;
  deleted?: boolean;
}

export interface SyncState {
  notes: Record<string, SyncStateEntry>;
}

export interface PushChange {
  path_hash: string;
  encrypted_path: string;
  encrypted_content?: string;
  encrypted_dek?: string;
  version_vector: Record<string, number>;
  operation: "create" | "update" | "delete";
  file_size?: number;
  mime_type?: string;
}

export interface RemoteChange {
  note_id: string | null;
  path_hash: string | null;
  encrypted_path: string | null;
  encrypted_content: string | null;
  encrypted_dek: string | null;
  version_vector: Record<string, number> | null;
  operation: "create" | "update" | "delete";
  modified_at: string;
}

export interface ConflictChange {
  note_id: string;
  path_hash: string;
  server_version_vector: Record<string, number>;
  client_version_vector: Record<string, number>;
  encrypted_path: string;
  encrypted_content: string | null;
  encrypted_dek: string | null;
}

export interface PushResponse {
  accepted: Array<{
    note_id: string;
    path_hash: string;
    operation: string;
    version_vector: Record<string, number>;
  }>;
  conflicts: ConflictChange[];
}

export interface NoteVersionInfo {
  id: number;
  note_id: string;
  operation: string;
  version_vector: Record<string, number>;
  file_size: number | null;
  mime_type: string;
  created_at: string;
}

export interface NoteVersionPayload extends NoteVersionInfo {
  path_hash: string;
  encrypted_path: string;
  encrypted_content: string | null;
  encrypted_dek: string | null;
}

export interface DeviceInfo {
  id: string;
  device_name: string | null;
  platform: string | null;
  last_seen: string | null;
  created_at: string;
  revoked_at: string | null;
  current: boolean;
}

export interface HermesQueueItem {
  id: number;
  target_note_path: string | null;
  merge_content: string | null;
  source_url: string | null;
  source_type: string | null;
  status: string;
  created_at: string;
}
