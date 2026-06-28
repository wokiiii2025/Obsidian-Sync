import { Notice, TFile, Vault } from "obsidian";
import { CONFLICT_DIR, PROTECTED_EXCLUSIONS } from "./defaults";
import { CryptoService } from "./crypto";
import { t } from "./i18n";
import { SyncApi } from "./api";
import { isFileTypeSyncEnabled } from "./file-policy";
import { loadSyncState, saveSyncState } from "./state";
import type { PluginSettings, PushChange, RemoteChange, SyncState, SyncStatus } from "./types";

const MAX_SYNC_HISTORY = 20;

interface LocalSyncFile {
  path: string;
  extension: string;
  size: number;
  mtime: number;
  file?: TFile;
}

export class SyncEngine {
  private running = false;

  constructor(
    private readonly vault: Vault,
    private readonly settings: PluginSettings,
    private readonly api: SyncApi,
    private readonly crypto: CryptoService,
    private readonly saveSettings: () => Promise<void>
  ) {}

  async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.settings.lastSyncStats.lastStartedAt = new Date().toISOString();
    this.settings.lastSyncStats.lastError = "";
    if (!this.crypto.isUnlocked()) {
      this.settings.lastSyncStatus = "locked";
      this.settings.lastSyncStats.lastFinishedAt = new Date().toISOString();
      this.recordSyncHistory("locked");
      await this.saveSettings();
      new Notice(t(this.settings.language, "notice.unlockFirst"));
      return;
    }

    this.running = true;
    this.settings.lastSyncStatus = "running";
    this.settings.lastSyncStats.downloaded = 0;
    this.settings.lastSyncStats.uploaded = 0;
    this.settings.lastSyncStats.conflicts = 0;
    await this.saveSettings();
    try {
      const state = await loadSyncState(this.vault);
      await this.applyRemoteChanges(state);
      await this.pushLocalChanges(state);
      this.settings.lastSync = new Date().toISOString();
      this.settings.lastSyncStatus = "success";
      this.settings.lastSyncStats.trackedNotes = Object.keys(state.notes).length;
      this.settings.lastSyncStats.lastFinishedAt = this.settings.lastSync;
      this.recordSyncHistory("success");
      await saveSyncState(this.vault, state);
      await this.saveSettings();
      new Notice(t(this.settings.language, "notice.syncCompleteStats", {
        uploaded: this.settings.lastSyncStats.uploaded,
        downloaded: this.settings.lastSyncStats.downloaded,
        conflicts: this.settings.lastSyncStats.conflicts
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settings.lastSyncStatus = "error";
      this.settings.lastSyncStats.lastError = message;
      this.settings.lastSyncStats.lastFinishedAt = new Date().toISOString();
      this.recordSyncHistory("error");
      await this.saveSettings();
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async applyRemoteChanges(state: SyncState): Promise<void> {
    const changes = await this.api.changes(this.settings.lastSync);
    this.settings.lastSyncStats.downloaded = changes.length;
    for (const change of changes) {
      if (!change.path_hash) {
        continue;
      }
      if (change.operation === "delete") {
        await this.applyRemoteDelete(change, state);
      } else {
        await this.applyRemoteUpsert(change, state);
      }
    }
  }

  private async applyRemoteUpsert(change: RemoteChange, state: SyncState): Promise<void> {
    if (!change.path_hash || !change.encrypted_path || !change.encrypted_content || !change.encrypted_dek || !change.version_vector) {
      return;
    }
    const decrypted = await this.crypto.decryptRemoteFile(change.path_hash, change.encrypted_path, change.encrypted_content, change.encrypted_dek);
    if (!isFileTypeSyncEnabled(extensionForPath(decrypted.path), this.settings)) {
      return;
    }
    const existing = this.vault.getAbstractFileByPath(decrypted.path);
    if (existing && "extension" in existing) {
      await this.vault.modifyBinary(existing as TFile, decrypted.content.buffer as ArrayBuffer);
      state.notes[decrypted.path] = {
        pathHash: change.path_hash,
        versionVector: change.version_vector,
        modifiedTime: (existing as TFile).stat.mtime
      };
      return;
    }
    await this.ensureParentFolder(decrypted.path);
    if (this.isDotObsidianPath(decrypted.path)) {
      await this.vault.adapter.writeBinary(decrypted.path, decrypted.content.buffer as ArrayBuffer);
      const stat = await this.vault.adapter.stat(decrypted.path);
      state.notes[decrypted.path] = {
        pathHash: change.path_hash,
        versionVector: change.version_vector,
        modifiedTime: stat?.mtime ?? Date.now()
      };
      return;
    }
    const created = await this.vault.createBinary(decrypted.path, decrypted.content.buffer as ArrayBuffer);
    state.notes[decrypted.path] = {
      pathHash: change.path_hash,
      versionVector: change.version_vector,
      modifiedTime: created.stat.mtime
    };
  }

  private async applyRemoteDelete(change: RemoteChange, state: SyncState): Promise<void> {
    const path = Object.keys(state.notes).find((candidate) => state.notes[candidate].pathHash === change.path_hash);
    if (!path) {
      return;
    }
    if (!isFileTypeSyncEnabled(extensionForPath(path), this.settings)) {
      return;
    }
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing && "extension" in existing) {
      await this.vault.delete(existing);
    } else if (await this.vault.adapter.exists(path)) {
      await this.vault.adapter.remove(path);
    }
    delete state.notes[path];
  }

  private async pushLocalChanges(state: SyncState): Promise<void> {
    const changes: PushChange[] = [];
    const files = await this.listLocalSyncFiles();

    for (const file of files) {
      const tracked = state.notes[file.path];
      if (tracked && tracked.modifiedTime >= file.mtime) {
        continue;
      }
      const content = new Uint8Array(file.file ? await this.vault.readBinary(file.file) : await this.vault.adapter.readBinary(file.path));
      const encrypted = await this.crypto.encryptFile(file.path, content);
      const versionVector = { ...(tracked?.versionVector ?? {}) };
      versionVector[this.settings.deviceId] = (versionVector[this.settings.deviceId] ?? 0) + 1;
      changes.push({
        path_hash: encrypted.pathHash,
        encrypted_path: encrypted.encryptedPath,
        encrypted_content: encrypted.encryptedContent,
        encrypted_dek: encrypted.encryptedDek,
        version_vector: versionVector,
        operation: tracked ? "update" : "create",
        file_size: file.size,
        mime_type: mimeTypeForPath(file.path)
      });
      state.notes[file.path] = {
        pathHash: encrypted.pathHash,
        versionVector,
        modifiedTime: file.mtime
      };
    }

    for (const path of Object.keys(state.notes)) {
      if (this.isExcluded(path)) {
        continue;
      }
      if (!isFileTypeSyncEnabled(extensionForPath(path), this.settings)) {
        continue;
      }
      if (this.vault.getAbstractFileByPath(path) || await this.vault.adapter.exists(path)) {
        continue;
      }
      const tracked = state.notes[path];
      const versionVector = { ...tracked.versionVector };
      versionVector[this.settings.deviceId] = (versionVector[this.settings.deviceId] ?? 0) + 1;
      changes.push({
        path_hash: tracked.pathHash,
        encrypted_path: "",
        version_vector: versionVector,
        operation: "delete"
      });
      delete state.notes[path];
    }

    if (changes.length === 0) {
      return;
    }

    const response = await this.api.push(changes);
    this.settings.lastSyncStats.uploaded = response.accepted.length;
    this.settings.lastSyncStats.conflicts = response.conflicts.length;
    for (const conflict of response.conflicts) {
      if (!conflict.encrypted_content || !conflict.encrypted_dek) {
        continue;
      }
      const remote = await this.crypto.decryptRemoteFile(conflict.path_hash, conflict.encrypted_path, conflict.encrypted_content, conflict.encrypted_dek);
      const conflictPath = `${CONFLICT_DIR}/${remote.path.replace(/[\\/]/g, "-")}-${Date.now()}`;
      await this.ensureParentFolder(conflictPath);
      await this.vault.createBinary(conflictPath, remote.content.buffer as ArrayBuffer);
      this.settings.conflictRecords = [
        {
          originalPath: remote.path,
          conflictPath,
          createdAt: new Date().toISOString()
        },
        ...(this.settings.conflictRecords ?? [])
      ].slice(0, 50);
    }
    if (response.conflicts.length > 0) {
      new Notice(t(this.settings.language, "notice.conflicts", { count: response.conflicts.length }));
    }
  }

  private isExcluded(path: string): boolean {
    const patterns = [...PROTECTED_EXCLUSIONS, ...this.settings.exclusions.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)];
    return patterns.some((pattern) => {
      if (pattern.endsWith("/**")) {
        return path.startsWith(pattern.slice(0, -3));
      }
      return path === pattern || path.startsWith(`${pattern}/`);
    });
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.isDotObsidianPath(current) || current === ".obsidian") {
        if (!(await this.vault.adapter.exists(current))) {
          await this.vault.adapter.mkdir(current);
        }
      } else if (!this.vault.getAbstractFileByPath(current)) {
        await this.vault.createFolder(current);
      }
    }
  }

  private async listLocalSyncFiles(): Promise<LocalSyncFile[]> {
    const files = new Map<string, LocalSyncFile>();
    for (const file of this.vault.getFiles()) {
      if (!this.isExcluded(file.path) && isFileTypeSyncEnabled(file.extension, this.settings)) {
        files.set(file.path, {
          path: file.path,
          extension: file.extension,
          size: file.stat.size,
          mtime: file.stat.mtime,
          file
        });
      }
    }
    for (const path of await this.listAdapterFiles(".obsidian")) {
      if (files.has(path) || this.isExcluded(path) || !isFileTypeSyncEnabled(extensionForPath(path), this.settings)) {
        continue;
      }
      const stat = await this.vault.adapter.stat(path);
      files.set(path, {
        path,
        extension: extensionForPath(path),
        size: stat?.size ?? 0,
        mtime: stat?.mtime ?? 0
      });
    }
    return [...files.values()];
  }

  private async listAdapterFiles(folder: string): Promise<string[]> {
    if (!(await this.vault.adapter.exists(folder))) {
      return [];
    }
    const listed = await this.vault.adapter.list(folder);
    const nested = await Promise.all(listed.folders.map((child) => this.listAdapterFiles(child)));
    return [...listed.files, ...nested.flat()];
  }

  private isDotObsidianPath(path: string): boolean {
    return path === ".obsidian" || path.startsWith(".obsidian/");
  }

  private recordSyncHistory(status: SyncStatus): void {
    const entry = {
      ...this.settings.lastSyncStats,
      status
    };
    this.settings.syncHistory = [entry, ...(this.settings.syncHistory ?? [])].slice(0, MAX_SYNC_HISTORY);
  }
}

function extensionForPath(path: string): string {
  const filename = path.split("/").pop() ?? path;
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1) : "";
}

function mimeTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    mov: "video/quicktime"
  };
  return types[extension] ?? "application/octet-stream";
}
