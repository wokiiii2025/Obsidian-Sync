import { Notice, TFile, Vault } from "obsidian";
import { CONFLICT_DIR } from "./defaults";
import { CryptoService } from "./crypto";
import { t } from "./i18n";
import { SyncApi } from "./api";
import { isPathExcluded, isPathSyncEnabled, isPluginDirectoryPath } from "./file-policy";
import { loadSyncState, saveSyncState } from "./state";
import type { ConflictChange, PluginSettings, PushChange, RemoteChange, SyncState, SyncStatus } from "./types";

const MAX_SYNC_HISTORY = 20;
const REMOTE_CHANGE_PAGE_SIZE = 50;

interface LocalSyncFile {
  path: string;
  extension: string;
  size: number;
  mtime: number;
  file?: TFile;
}

export class SyncEngine {
  private running = false;
  private readonly downloadedPaths = new Set<string>();

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
    this.downloadedPaths.clear();
    this.settings.lastSyncStatus = "running";
    this.settings.lastSyncStats.downloaded = 0;
    this.settings.lastSyncStats.uploaded = 0;
    this.settings.lastSyncStats.conflicts = 0;
    await this.saveSettings();
    try {
      await this.cleanupLocalDuplicates();
      let recoveredState = false;
      const state = await loadSyncState(this.vault, (info) => {
        recoveredState = true;
        new Notice(t(this.settings.language, "notice.stateRecovered", { path: info.backupPath }));
      });
      if (recoveredState) {
        this.settings.lastSync = "";
      }
      this.pruneExcludedStateEntries(state);
      const checkpoint = await this.applyRemoteChanges(state);
      await this.pushLocalChanges(state);
      this.settings.lastSync = checkpoint || new Date().toISOString();
      this.settings.lastSyncStatus = "success";
      this.settings.lastSyncStats.pluginFiles = Object.keys(state.notes).filter(isPluginDirectoryPath).length;
      this.settings.lastSyncStats.trackedNotes = Object.keys(state.notes).length - this.settings.lastSyncStats.pluginFiles;
      this.settings.lastSyncStats.lastFinishedAt = this.settings.lastSync;
      this.recordSyncHistory("success");
      await saveSyncState(this.vault, state);
      await this.saveSettings();
      new Notice(t(this.settings.language, "notice.syncCompleteStats", {
        uploaded: this.settings.lastSyncStats.uploaded,
        downloaded: this.settings.lastSyncStats.downloaded,
        conflicts: this.settings.lastSyncStats.conflicts,
        pluginFiles: this.settings.lastSyncStats.pluginFiles
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

  private async applyRemoteChanges(state: SyncState): Promise<string> {
    let cursor: number | undefined;
    let checkpoint = "";
    let downloaded = 0;
    for (;;) {
      const page = await this.api.changes(this.settings.lastSync, {
        limit: REMOTE_CHANGE_PAGE_SIZE,
        cursor,
        checkpoint: checkpoint || undefined
      });
      checkpoint = checkpoint || page.checkpoint;
      downloaded += page.changes.length;
      this.settings.lastSyncStats.downloaded = downloaded;
      for (const change of page.changes) {
        if (!change.path_hash) {
          continue;
        }
        if (change.operation === "delete") {
          await this.applyRemoteDelete(change, state);
        } else {
          await this.applyRemoteUpsert(change, state);
        }
      }
      if (!page.has_more || page.next_cursor === null) {
        return checkpoint;
      }
      cursor = page.next_cursor;
    }
  }

  private async applyRemoteUpsert(change: RemoteChange, state: SyncState): Promise<void> {
    if (!change.path_hash || !change.encrypted_path || !change.encrypted_content || !change.encrypted_dek || !change.version_vector) {
      return;
    }
    const decrypted = await this.crypto.decryptRemoteFile(change.path_hash, change.encrypted_path, change.encrypted_content, change.encrypted_dek);
    if (this.isExcluded(decrypted.path) || !isPathSyncEnabled(decrypted.path, extensionForPath(decrypted.path), this.settings)) {
      return;
    }
    const modifiedTime = await this.writeRemoteFile(decrypted.path, decrypted.content);
    state.notes[decrypted.path] = {
      pathHash: change.path_hash,
      versionVector: change.version_vector,
      modifiedTime
    };
    this.downloadedPaths.add(decrypted.path);
  }

  private async applyRemoteDelete(change: RemoteChange, state: SyncState): Promise<void> {
    const path = Object.keys(state.notes).find((candidate) => state.notes[candidate].pathHash === change.path_hash);
    if (!path) {
      return;
    }
    if (this.isExcluded(path)) {
      delete state.notes[path];
      return;
    }
    if (!isPathSyncEnabled(path, extensionForPath(path), this.settings)) {
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
      if ((tracked && tracked.modifiedTime >= file.mtime) || this.downloadedPaths.has(file.path)) {
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
      if (!isPathSyncEnabled(path, extensionForPath(path), this.settings)) {
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

    const allConflicts: ConflictChange[] = [];
    let uploaded = 0;
    for (let i = 0; i < changes.length; i += 10) {
      const chunk = changes.slice(i, i + 10);
      const response = await this.api.push(chunk);
      uploaded += response.accepted.length;
      allConflicts.push(...response.conflicts);
    }
    this.settings.lastSyncStats.uploaded = uploaded;
    this.settings.lastSyncStats.conflicts = allConflicts.length;
    for (const conflict of allConflicts) {
      if (!conflict.encrypted_content || !conflict.encrypted_dek) {
        continue;
      }
      const remote = await this.crypto.decryptRemoteFile(conflict.path_hash, conflict.encrypted_path, conflict.encrypted_content, conflict.encrypted_dek);
      const conflictPath = `${CONFLICT_DIR}/${remote.path.replace(/[\\/]/g, "-")}-${Date.now()}`;
      await this.ensureParentFolder(conflictPath);
      await this.vault.createBinary(conflictPath, toExactArrayBuffer(remote.content));
      this.settings.conflictRecords = [
        {
          originalPath: remote.path,
          conflictPath,
          createdAt: new Date().toISOString()
        },
        ...(this.settings.conflictRecords ?? [])
      ].slice(0, 50);
    }
    if (allConflicts.length > 0) {
      new Notice(t(this.settings.language, "notice.conflicts", { count: allConflicts.length }));
    }
  }

  private async cleanupLocalDuplicates(): Promise<void> {
    try {
      const files = await this.listLocalSyncFiles();
      const bySize = new Map<number, LocalSyncFile[]>();
      for (const file of files) {
        if (file.extension.toLowerCase() === "md" || this.isExcluded(file.path)) {
          continue;
        }
        if (!bySize.has(file.size)) {
          bySize.set(file.size, []);
        }
        bySize.get(file.size)!.push(file);
      }
      let removed = 0;
      for (const sizeFiles of bySize.values()) {
        if (sizeFiles.length < 2) {
          continue;
        }
        sizeFiles.sort((a, b) => a.path.length - b.path.length);
        const seen: { bytes: Uint8Array }[] = [];
        for (const file of sizeFiles) {
          const content = new Uint8Array(file.file ? await this.vault.readBinary(file.file) : await this.vault.adapter.readBinary(file.path));
          let duplicate = false;
          for (const candidate of seen) {
            if (candidate.bytes.length !== content.length) {
              continue;
            }
            let same = true;
            for (let i = 0; i < content.length; i++) {
              if (candidate.bytes[i] !== content[i]) {
                same = false;
                break;
              }
            }
            if (same) {
              duplicate = true;
              break;
            }
          }
          if (duplicate) {
            removed++;
            try {
              if (file.file) {
                await this.vault.trash(file.file, true);
              } else {
                await this.vault.adapter.remove(file.path);
              }
            } catch (error) {
              // 忽略单个文件删除失败
            }
          } else {
            seen.push({ bytes: new Uint8Array(content) });
          }
        }
      }
      if (removed > 0) {
        new Notice(`已自动清理 ${removed} 个重复附件`);
      }
    } catch (error) {
      // 清理失败不阻断同步
    }
  }

  private isExcluded(path: string): boolean {
    return isPathExcluded(path, this.settings.exclusions);
  }

  private pruneExcludedStateEntries(state: SyncState): void {
    for (const path of Object.keys(state.notes)) {
      if (this.isExcluded(path)) {
        delete state.notes[path];
      }
    }
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
      } else if (!this.vault.getAbstractFileByPath(current) && !(await this.vault.adapter.exists(current))) {
        await this.vault.createFolder(current);
      }
    }
  }

  private async writeRemoteFile(path: string, content: Uint8Array): Promise<number> {
    await this.ensureParentFolder(path);
    const buffer = toExactArrayBuffer(content);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing && "extension" in existing) {
      await this.vault.modifyBinary(existing as TFile, buffer);
      const stat = await this.vault.adapter.stat(path);
      return stat?.mtime ?? (existing as TFile).stat.mtime;
    }
    if (this.isDotObsidianPath(path) || await this.vault.adapter.exists(path)) {
      await this.vault.adapter.writeBinary(path, buffer);
      const stat = await this.vault.adapter.stat(path);
      return stat?.mtime ?? Date.now();
    }
    const created = await this.vault.createBinary(path, buffer);
    return created.stat.mtime;
  }

  private async listLocalSyncFiles(): Promise<LocalSyncFile[]> {
    const files = new Map<string, LocalSyncFile>();
    for (const file of this.vault.getFiles()) {
      if (!this.isExcluded(file.path) && isPathSyncEnabled(file.path, file.extension, this.settings)) {
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
      if (files.has(path) || this.isExcluded(path) || !isPathSyncEnabled(path, extensionForPath(path), this.settings)) {
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

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
