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
  manageAttachments: boolean;
  attachmentFolder: string;
  attachmentOrganizationMode: AttachmentOrganizationMode;
  attachmentDateFormat: string;
  conflictMode: "auto" | "manual";
  exclusions: string;
  lastSync: string;
  lastSyncStatus: SyncStatus;
  lastSyncStats: SyncStats;
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
