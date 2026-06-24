import { Notice, TFile, Vault } from "obsidian";
import { CONFLICT_DIR } from "./defaults";
import { CryptoService } from "./crypto";
import { t } from "./i18n";
import { SyncApi } from "./api";
import { loadSyncState, saveSyncState } from "./state";
import type { PluginSettings, PushChange, RemoteChange, SyncState } from "./types";

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
      await saveSyncState(this.vault, state);
      await this.saveSettings();
      new Notice(t(this.settings.language, "notice.syncComplete"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settings.lastSyncStatus = "error";
      this.settings.lastSyncStats.lastError = message;
      this.settings.lastSyncStats.lastFinishedAt = new Date().toISOString();
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
    const decrypted = await this.crypto.decryptRemote(change.path_hash, change.encrypted_path, change.encrypted_content, change.encrypted_dek);
    const existing = this.vault.getAbstractFileByPath(decrypted.path);
    if (existing && "extension" in existing) {
      await this.vault.modify(existing as TFile, decrypted.content);
      state.notes[decrypted.path] = {
        pathHash: change.path_hash,
        versionVector: change.version_vector,
        modifiedTime: (existing as TFile).stat.mtime
      };
      return;
    }
    await this.ensureParentFolder(decrypted.path);
    const created = await this.vault.create(decrypted.path, decrypted.content);
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
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing && "extension" in existing) {
      await this.vault.delete(existing);
    }
    delete state.notes[path];
  }

  private async pushLocalChanges(state: SyncState): Promise<void> {
    const changes: PushChange[] = [];
    const files = this.vault.getMarkdownFiles().filter((file) => !this.isExcluded(file.path));

    for (const file of files) {
      const tracked = state.notes[file.path];
      if (tracked && tracked.modifiedTime >= file.stat.mtime) {
        continue;
      }
      const content = await this.vault.read(file);
      const encrypted = await this.crypto.encryptNote(file.path, content);
      const versionVector = { ...(tracked?.versionVector ?? {}) };
      versionVector[this.settings.deviceId] = (versionVector[this.settings.deviceId] ?? 0) + 1;
      changes.push({
        path_hash: encrypted.pathHash,
        encrypted_path: encrypted.encryptedPath,
        encrypted_content: encrypted.encryptedContent,
        encrypted_dek: encrypted.encryptedDek,
        version_vector: versionVector,
        operation: tracked ? "update" : "create",
        file_size: file.stat.size,
        mime_type: "text/markdown"
      });
      state.notes[file.path] = {
        pathHash: encrypted.pathHash,
        versionVector,
        modifiedTime: file.stat.mtime
      };
    }

    for (const path of Object.keys(state.notes)) {
      if (this.isExcluded(path)) {
        continue;
      }
      if (this.vault.getAbstractFileByPath(path)) {
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
      const remote = await this.crypto.decryptRemote(conflict.path_hash, conflict.encrypted_path, conflict.encrypted_content, conflict.encrypted_dek);
      const conflictPath = `${CONFLICT_DIR}/${remote.path.replace(/[\\/]/g, "-")}-${Date.now()}.md`;
      await this.ensureParentFolder(conflictPath);
      await this.vault.create(conflictPath, remote.content);
    }
    if (response.conflicts.length > 0) {
      new Notice(t(this.settings.language, "notice.conflicts", { count: response.conflicts.length }));
    }
  }

  private isExcluded(path: string): boolean {
    const patterns = this.settings.exclusions.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
      if (!this.vault.getAbstractFileByPath(current)) {
        await this.vault.createFolder(current);
      }
    }
  }
}
