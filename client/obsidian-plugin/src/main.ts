import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, requestUrl, setIcon } from "obsidian";
import { SyncApi } from "./api";
import { CryptoService } from "./crypto";
import { CONFLICT_DIR, DEFAULT_SETTINGS, LEGACY_DEFAULT_EXCLUSIONS, PROTECTED_EXCLUSIONS } from "./defaults";
import { isManagedAttachmentExtension, isPathSyncEnabled } from "./file-policy";
import { t } from "./i18n";
import { SyncEngine } from "./sync-engine";
import type { AttachmentOrganizationMode, DeviceInfo, HermesQueueItem, Language, NoteVersionInfo, PluginSettings } from "./types";

interface RemotePluginManifest {
  id: string;
  name: string;
  version: string;
}

export default class ZeroKnowledgeSyncPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  crypto = new CryptoService();
  api = new SyncApi(() => this.settings.serverUrl, () => this.settings.token);
  intervalId: number | null = null;
  hermesAgentIntervalId: number | null = null;
  hermesAgentInitialTimeoutId: number | null = null;
  autoSyncTimeoutId: number | null = null;
  syncPromise: Promise<void> | null = null;
  hermesAgentPromise: Promise<void> | null = null;
  hermesAgentConfigKey = "";
  queuedAutoSync = false;
  organizingAttachmentPaths = new Set<string>();
  bulkAttachmentOrganizing = false;
  statusBarEl: HTMLElement | null = null;
  activeFileVersions: NoteVersionInfo[] = [];
  devices: DeviceInfo[] = [];
  telegramQueueItems: HermesQueueItem[] = [];
  latestUpdateManifest: RemotePluginManifest | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerExtensions(["json"], "markdown");
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("zk-sync-status");
    this.statusBarEl.setAttribute("role", "button");
    this.statusBarEl.setAttribute("tabindex", "0");
    this.statusBarEl.setAttribute("aria-label", t(this.settings.language, "statusbar.aria"));
    this.registerDomEvent(this.statusBarEl, "click", () => {
      this.syncNow().catch((error) => new Notice(t(this.settings.language, "notice.syncFailed", { message: error.message })));
    });
    this.registerDomEvent(this.statusBarEl, "keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.syncNow().catch((error) => new Notice(t(this.settings.language, "notice.syncFailed", { message: error.message })));
      }
    });
    this.updateStatusBar();
    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.addCommand({
      id: "zero-knowledge-sync-now",
      name: t(this.settings.language, "command.syncNow"),
      callback: () => this.syncNow()
    });
    this.addCommand({
      id: "zero-knowledge-sync-lock",
      name: t(this.settings.language, "command.lock"),
      callback: () => {
        this.crypto.lock();
        this.settings.lastSyncStatus = "locked";
        this.saveSettings().catch(() => undefined);
        new Notice(t(this.settings.language, "notice.locked"));
      }
    });
    this.addCommand({
      id: "zero-knowledge-sync-scan-orphans",
      name: t(this.settings.language, "settings.orphans.name"),
      callback: () => {
        new Notice(t(this.settings.language, "notice.actionStarted", { action: t(this.settings.language, "settings.orphans.button") }));
        this.scanOrphanAttachments().catch((error) => new Notice(t(this.settings.language, "notice.prefix", { message: error.message })));
      }
    });
    this.addCommand({
      id: "zero-knowledge-sync-load-history",
      name: t(this.settings.language, "settings.versions.name"),
      callback: () => {
        new Notice(t(this.settings.language, "notice.actionStarted", { action: t(this.settings.language, "settings.versions.button") }));
        this.loadActiveFileVersions().catch((error) => new Notice(t(this.settings.language, "notice.prefix", { message: error.message })));
      }
    });
    this.addCommand({
      id: "zero-knowledge-sync-refresh-devices",
      name: t(this.settings.language, "settings.devices.name"),
      callback: () => {
        new Notice(t(this.settings.language, "notice.actionStarted", { action: t(this.settings.language, "settings.devices.refresh") }));
        this.refreshDevices().catch((error) => new Notice(t(this.settings.language, "notice.prefix", { message: error.message })));
      }
    });
    this.addCommand({
      id: "zero-knowledge-sync-import-telegram-queue",
      name: t(this.settings.language, "settings.telegram.import.name"),
      callback: () => {
        new Notice(t(this.settings.language, "notice.actionStarted", { action: t(this.settings.language, "settings.telegram.import.button") }));
        this.importTelegramQueue().catch((error) => new Notice(t(this.settings.language, "notice.prefix", { message: error.message })));
      }
    });
    this.addCommand({
      id: "zero-knowledge-sync-check-update",
      name: t(this.settings.language, "settings.updates.check.name"),
      callback: () => {
        new Notice(t(this.settings.language, "notice.actionStarted", { action: t(this.settings.language, "settings.updates.check.button") }));
        this.checkForPluginUpdate().catch((error) => new Notice(t(this.settings.language, "notice.prefix", { message: error.message })));
      }
    });
    this.registerFileWatchers();
    this.configureInterval();
    this.configureHermesAgent();
    const initialAttachmentTimer = window.setTimeout(() => {
      this.promptInitialAttachmentOrganization().catch((error) => new Notice(t(this.settings.language, "notice.prefix", { message: error.message })));
    }, 1500);
    this.register(() => window.clearTimeout(initialAttachmentTimer));
    if (this.settings.updateCheckEnabled) {
      const updateTimer = window.setTimeout(() => {
        this.checkForPluginUpdate(true).catch((error) => new Notice(t(this.settings.language, "notice.prefix", { message: error.message })));
      }, 5000);
      this.register(() => window.clearTimeout(updateTimer));
    }
  }

  onunload(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
    }
    if (this.hermesAgentIntervalId !== null) {
      window.clearInterval(this.hermesAgentIntervalId);
    }
    if (this.hermesAgentInitialTimeoutId !== null) {
      window.clearTimeout(this.hermesAgentInitialTimeoutId);
    }
    if (this.autoSyncTimeoutId !== null) {
      window.clearTimeout(this.autoSyncTimeoutId);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.settings.exclusions === LEGACY_DEFAULT_EXCLUSIONS) {
      this.settings.exclusions = DEFAULT_SETTINGS.exclusions;
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.configureInterval();
    this.configureHermesAgent();
    this.updateStatusBar();
  }

  async unlock(password: string): Promise<void> {
    await this.crypto.unlock(password);
    new Notice(t(this.settings.language, "notice.unlocked"));
    this.updateStatusBar();
  }

  async scanOrphanAttachments(): Promise<string[]> {
    const folder = normalizePath(this.settings.attachmentFolder || DEFAULT_SETTINGS.attachmentFolder);
    const markdownFiles = this.app.vault.getMarkdownFiles().filter((file) => !this.isExcludedPath(file.path));
    const referencedTargets = new Set<string>();
    for (const file of markdownFiles) {
      const content = await this.app.vault.read(file);
      for (const target of extractAttachmentTargets(content)) {
        referencedTargets.add(target);
        referencedTargets.add(target.split("/").pop() ?? target);
      }
    }
    const orphanAttachments = this.app.vault.getFiles()
      .filter((file) => isManagedAttachmentExtension(file.extension))
      .filter((file) => !this.isExcludedPath(file.path))
      .filter((file) => file.path.startsWith(`${folder}/`))
      .filter((file) => {
        const basename = file.path.split("/").pop() ?? file.path;
        return !referencedTargets.has(file.path) && !referencedTargets.has(basename);
      })
      .map((file) => file.path)
      .sort();
    this.settings.orphanAttachments = orphanAttachments;
    this.settings.lastOrphanScanAt = new Date().toISOString();
    await this.saveSettings();
    new Notice(t(this.settings.language, "notice.orphanScanComplete", { count: orphanAttachments.length }));
    return orphanAttachments;
  }

  async organizeExistingAttachments(): Promise<number> {
    const files = this.unmanagedAttachmentFiles();
    let organized = 0;
    this.bulkAttachmentOrganizing = true;
    try {
      for (const file of files) {
        const current = this.app.vault.getAbstractFileByPath(file.path);
        if (current instanceof TFile && current.extension !== "md") {
          await this.organizeAttachment(current);
          organized += 1;
        }
      }
    } finally {
      this.bulkAttachmentOrganizing = false;
    }
    this.settings.attachmentMigrationPrompted = true;
    this.settings.lastAttachmentMigrationAt = new Date().toISOString();
    await this.saveSettings();
    new Notice(t(this.settings.language, "notice.attachmentsOrganized", { count: organized }));
    if (organized > 0) {
      this.scheduleAutoSync();
    }
    return organized;
  }

  async cleanupOrphanAttachments(): Promise<number> {
    const orphanPaths = await this.scanOrphanAttachments();
    if (orphanPaths.length === 0) {
      return 0;
    }
    return new Promise((resolve) => {
      new ConfirmModal(
        this.app,
        t(this.settings.language, "modal.cleanup.title"),
        t(this.settings.language, "modal.cleanup.desc", { count: orphanPaths.length }),
        t(this.settings.language, "modal.cleanup.confirm"),
        t(this.settings.language, "modal.cancel"),
        async () => {
          let cleaned = 0;
          for (const path of orphanPaths) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
              await this.app.vault.trash(file, true);
              cleaned += 1;
            }
          }
          this.settings.orphanAttachments = [];
          this.settings.lastAttachmentCleanupAt = new Date().toISOString();
          await this.saveSettings();
          new Notice(t(this.settings.language, "notice.orphanCleanupComplete", { count: cleaned }));
          resolve(cleaned);
        },
        () => resolve(0)
      ).open();
    });
  }

  countUnmanagedAttachments(): number {
    return this.unmanagedAttachmentFiles().length;
  }

  async loadActiveFileVersions(): Promise<NoteVersionInfo[]> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      throw new Error(t(this.settings.language, "error.activeFileRequired"));
    }
    const versions = await this.api.history(this.crypto.pathHash(file.path));
    this.activeFileVersions = versions;
    new Notice(t(this.settings.language, "notice.versionsLoaded", { count: versions.length }));
    return versions;
  }

  async restoreVersion(versionId: number): Promise<void> {
    await this.api.restoreVersion(versionId);
    await this.syncNow();
    new Notice(t(this.settings.language, "notice.versionRestored"));
  }

  async refreshDevices(): Promise<DeviceInfo[]> {
    this.devices = await this.api.devices();
    new Notice(t(this.settings.language, "notice.devicesLoaded", { count: this.devices.length }));
    return this.devices;
  }

  async loadTelegramQueue(): Promise<HermesQueueItem[]> {
    this.telegramQueueItems = await this.api.hermesQueue();
    new Notice(t(this.settings.language, "notice.telegramQueueLoaded", { count: this.telegramQueueItems.length }));
    return this.telegramQueueItems;
  }

  async importTelegramQueue(silent = false): Promise<number> {
    const items = await this.api.hermesQueue();
    let imported = 0;
    for (const item of items) {
      const content = item.merge_content?.trim();
      if (!content) {
        await this.api.completeHermesQueueItem(item.id);
        continue;
      }
      const decision = await this.routeHermesItem(item, content);
      const existing = this.app.vault.getAbstractFileByPath(decision.targetPath);
      await this.ensureVaultFolder(parentFolder(decision.targetPath));
      if (existing instanceof TFile) {
        const original = await this.app.vault.read(existing);
        await this.app.vault.modify(existing, appendHermesBlock(original, decision.content, decision.heading));
      } else {
        await this.app.vault.create(decision.targetPath, createHermesNote(decision.title, decision.content, decision.reason));
      }
      await this.api.completeHermesQueueItem(item.id);
      imported += 1;
    }
    this.telegramQueueItems = [];
    if (imported > 0) {
      if (this.crypto.isUnlocked()) {
        await this.syncNow();
      } else {
        this.settings.lastSyncStatus = "locked";
        await this.saveSettings();
      }
    }
    if (!silent || imported > 0) {
      new Notice(t(this.settings.language, "notice.telegramQueueImported", { count: imported }));
    }
    return imported;
  }

  async routeHermesItem(item: HermesQueueItem, content: string): Promise<HermesRouteDecision> {
    const normalizedContent = content.trim();
    const index = await this.buildHermesVaultIndex();
    const rules = parseHermesRoutingRules(this.settings.hermesAgentRoutingRules);
    const rule = bestHermesRule(normalizedContent, rules);
    const fallbackPath = normalizePath(item.target_note_path || this.settings.hermesAgentInboxPath || DEFAULT_SETTINGS.hermesAgentInboxPath);
    const targetBaseFolder = rule?.targetFolder
      || normalizePath(this.settings.hermesAgentCreateFolder || DEFAULT_SETTINGS.hermesAgentCreateFolder)
      || parentFolder(fallbackPath);
    const candidates = scoreHermesCandidates(normalizedContent, index, rule?.keywords ?? []);
    const best = candidates[0];
    const threshold = Math.max(1, Number(this.settings.hermesAgentAppendScoreThreshold) || DEFAULT_SETTINGS.hermesAgentAppendScoreThreshold);
    if (best && best.score >= threshold) {
      return {
        action: "append_existing",
        targetPath: best.note.path,
        heading: best.heading || "Hermes",
        title: best.note.title,
        content: normalizedContent,
        reason: `Matched existing note with score ${best.score}.`
      };
    }
    const title = hermesTitle(normalizedContent, item.source_type || "Telegram");
    const targetPath = await this.uniqueMarkdownPath(`${targetBaseFolder}/${title}.md`);
    return {
      action: "create_new",
      targetPath,
      heading: "Hermes",
      title,
      content: normalizedContent,
      reason: rule ? `Matched route: ${rule.targetFolder}.` : "No strong existing-note match."
    };
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.api.revokeDevice(deviceId);
    await this.refreshDevices();
    new Notice(t(this.settings.language, "notice.deviceRevoked"));
  }

  async restoreConflict(recordIndex: number): Promise<void> {
    const record = this.settings.conflictRecords?.[recordIndex];
    if (!record) {
      return;
    }
    const conflict = this.app.vault.getAbstractFileByPath(record.conflictPath);
    if (!(conflict instanceof TFile)) {
      return;
    }
    await this.ensureVaultFolder(parentFolder(record.originalPath));
    const existing = this.app.vault.getAbstractFileByPath(record.originalPath);
    const content = await this.app.vault.readBinary(conflict);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, content);
    } else {
      await this.app.vault.createBinary(record.originalPath, content);
    }
    this.settings.conflictRecords.splice(recordIndex, 1);
    await this.saveSettings();
    this.scheduleAutoSync();
    new Notice(t(this.settings.language, "notice.conflictRestored"));
  }

  async fullResync(): Promise<void> {
    this.settings.lastSync = "";
    this.settings.lastSyncStatus = "idle";
    this.settings.lastSyncStats.lastError = "";
    if (await this.app.vault.adapter.exists(".obsidian/zero-knowledge-sync-state.json")) {
      await this.app.vault.adapter.remove(".obsidian/zero-knowledge-sync-state.json");
    }
    await this.saveSettings();
    new Notice(t(this.settings.language, "notice.fullSyncStarted"));
    await this.syncNow();
  }

  async checkForPluginUpdate(silent = false): Promise<RemotePluginManifest> {
    const manifest = await this.fetchRemotePluginManifest();
    this.latestUpdateManifest = manifest;
    this.settings.availableVersion = isNewerVersion(manifest.version, this.manifest.version) ? manifest.version : "";
    this.settings.lastUpdateCheckAt = new Date().toISOString();
    await this.saveSettings();
    if (!silent) {
      new Notice(t(this.settings.language, this.settings.availableVersion ? "notice.updateAvailable" : "notice.updateCurrent", { version: manifest.version }));
    } else if (this.settings.availableVersion) {
      new Notice(t(this.settings.language, "notice.updateAvailable", { version: manifest.version }));
    }
    return manifest;
  }

  async installPluginUpdate(): Promise<void> {
    const manifest = this.latestUpdateManifest ?? await this.checkForPluginUpdate(true);
    if (!isNewerVersion(manifest.version, this.manifest.version)) {
      new Notice(t(this.settings.language, "notice.updateCurrent", { version: manifest.version }));
      return;
    }
    const baseUrl = this.pluginRawBaseUrl();
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      const response = await requestUrl({ url: `${baseUrl}/${file}`, method: "GET" });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Update download failed: ${file}`);
      }
      await this.app.vault.adapter.write(`.obsidian/plugins/${this.manifest.id}/${file}`, response.text);
    }
    this.settings.availableVersion = "";
    this.settings.lastUpdateCheckAt = new Date().toISOString();
    await this.saveSettings();
    new Notice(t(this.settings.language, "notice.updateInstalled", { version: manifest.version }));
  }

  async syncNow(): Promise<void> {
    if (this.syncPromise) {
      return this.syncPromise;
    }
    const engine = new SyncEngine(this.app.vault, this.settings, this.api, this.crypto, async () => {
      await this.saveSettings();
      this.updateStatusBar();
    });
    this.syncPromise = engine.run()
      .finally(() => {
        this.syncPromise = null;
        this.updateStatusBar();
        if (this.queuedAutoSync) {
          this.queuedAutoSync = false;
          this.scheduleAutoSync();
        }
      });
    return this.syncPromise;
  }

  private async fetchRemotePluginManifest(): Promise<RemotePluginManifest> {
    const response = await requestUrl({ url: `${this.pluginRawBaseUrl()}/manifest.json`, method: "GET" });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Update check failed: HTTP ${response.status}`);
    }
    return JSON.parse(response.text) as RemotePluginManifest;
  }

  private pluginRawBaseUrl(): string {
    const repository = normalizeRepository(this.settings.updateRepository || DEFAULT_SETTINGS.updateRepository);
    const branch = encodeURIComponent(this.settings.updateBranch || DEFAULT_SETTINGS.updateBranch);
    return `https://raw.githubusercontent.com/${repository}/${branch}/client/obsidian-plugin`;
  }

  private configureInterval(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.settings.syncMode !== "periodic") {
      return;
    }
    const seconds = Math.max(10, this.settings.syncIntervalSeconds);
    this.intervalId = window.setInterval(() => {
      this.syncNow().catch((error) => new Notice(t(this.settings.language, "notice.syncFailed", { message: error.message })));
    }, seconds * 1000);
  }

  private configureHermesAgent(): void {
    const nextConfigKey = [
      this.settings.hermesAgentEnabled ? "on" : "off",
      this.settings.token ? "token" : "anonymous",
      Math.max(30, this.settings.hermesAgentIntervalSeconds || 60)
    ].join(":");
    if (nextConfigKey === this.hermesAgentConfigKey) {
      return;
    }
    this.hermesAgentConfigKey = nextConfigKey;
    if (this.hermesAgentIntervalId !== null) {
      window.clearInterval(this.hermesAgentIntervalId);
      this.hermesAgentIntervalId = null;
    }
    if (this.hermesAgentInitialTimeoutId !== null) {
      window.clearTimeout(this.hermesAgentInitialTimeoutId);
      this.hermesAgentInitialTimeoutId = null;
    }
    if (!this.settings.hermesAgentEnabled || !this.settings.token) {
      return;
    }
    const seconds = Math.max(30, this.settings.hermesAgentIntervalSeconds || 60);
    const run = () => {
      if (this.hermesAgentPromise) {
        return;
      }
      this.hermesAgentPromise = this.importTelegramQueue(true)
        .then(() => undefined)
        .catch((error) => {
          new Notice(t(this.settings.language, "notice.prefix", { message: error.message }));
        })
        .finally(() => {
          this.hermesAgentPromise = null;
        });
    };
    this.hermesAgentInitialTimeoutId = window.setTimeout(() => {
      this.hermesAgentInitialTimeoutId = null;
      run();
    }, 3000);
    this.hermesAgentIntervalId = window.setInterval(run, seconds * 1000);
  }

  private registerFileWatchers(): void {
    const handler = (file: TAbstractFile) => this.handleVaultChange(file);
    this.registerEvent(this.app.vault.on("create", handler));
    this.registerEvent(this.app.vault.on("modify", handler));
    this.registerEvent(this.app.vault.on("delete", handler));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleVaultChange(file, oldPath)));
  }

  private handleVaultChange(file: TAbstractFile, oldPath?: string): void {
    if (this.bulkAttachmentOrganizing) {
      return;
    }
    this.organizeAttachment(file, oldPath).catch((error) => {
      new Notice(t(this.settings.language, "notice.prefix", { message: error.message }));
    });
    if (!this.settings.autoSyncOnChange || !this.shouldAutoSyncFile(file)) {
      return;
    }
    this.scheduleAutoSync();
  }

  private shouldAutoSyncFile(file: TAbstractFile): boolean {
    if (!(file instanceof TFile)) {
      return false;
    }
    return !this.isExcludedPath(file.path) && isPathSyncEnabled(file.path, file.extension, this.settings);
  }

  private async promptInitialAttachmentOrganization(): Promise<void> {
    if (!this.settings.manageAttachments || this.settings.attachmentMigrationPrompted) {
      return;
    }
    const files = this.unmanagedAttachmentFiles();
    if (files.length === 0) {
      this.settings.attachmentMigrationPrompted = true;
      await this.saveSettings();
      return;
    }
    new ConfirmModal(
      this.app,
      t(this.settings.language, "modal.organize.title"),
      t(this.settings.language, "modal.organize.desc", { count: files.length }),
      t(this.settings.language, "modal.organize.confirm"),
      t(this.settings.language, "modal.cancel"),
      async () => {
        await this.organizeExistingAttachments();
      },
      async () => {
        this.settings.attachmentMigrationPrompted = true;
        await this.saveSettings();
      }
    ).open();
  }

  private unmanagedAttachmentFiles(): TFile[] {
    return this.app.vault.getFiles()
      .filter((file) => isManagedAttachmentExtension(file.extension))
      .filter((file) => !this.isExcludedPath(file.path))
      .filter((file) => !this.isInAttachmentFolder(file.path));
  }

  private async organizeAttachment(file: TAbstractFile, oldPath?: string): Promise<void> {
    if (!this.settings.manageAttachments || !(file instanceof TFile) || !isManagedAttachmentExtension(file.extension)) {
      return;
    }
    if (this.organizingAttachmentPaths.has(file.path) || this.isExcludedPath(file.path) || this.isInAttachmentFolder(file.path)) {
      return;
    }
    const attachmentFolder = this.targetAttachmentFolder(file);
    await this.ensureVaultFolder(attachmentFolder);
    const targetPath = await this.uniqueAttachmentPath(`${attachmentFolder}/${file.name}`);
    this.organizingAttachmentPaths.add(file.path);
    try {
      const sourcePath = oldPath ?? file.path;
      await this.app.vault.rename(file, targetPath);
      await this.rewriteAttachmentReferences(sourcePath, targetPath);
      if (!this.bulkAttachmentOrganizing) {
        new Notice(t(this.settings.language, "notice.attachmentMoved", { path: targetPath }));
      }
    } finally {
      this.organizingAttachmentPaths.delete(file.path);
      this.organizingAttachmentPaths.delete(targetPath);
    }
  }

  private async rewriteAttachmentReferences(oldPath: string, newPath: string): Promise<void> {
    const oldBasename = oldPath.split("/").pop() ?? oldPath;
    const markdownFiles = this.app.vault.getMarkdownFiles().filter((file) => !this.isExcludedPath(file.path));
    for (const file of markdownFiles) {
      const original = await this.app.vault.read(file);
      const updated = rewriteAttachmentLinks(original, oldPath, oldBasename, newPath);
      if (updated !== original) {
        await this.app.vault.modify(file, updated);
      }
    }
  }

  private isInAttachmentFolder(path: string): boolean {
    const folder = normalizePath(this.settings.attachmentFolder || DEFAULT_SETTINGS.attachmentFolder);
    return path === folder || path.startsWith(`${folder}/`);
  }

  private targetAttachmentFolder(file: TFile): string {
    const baseFolder = normalizePath(this.settings.attachmentFolder || DEFAULT_SETTINGS.attachmentFolder);
    const mode = this.settings.attachmentOrganizationMode ?? DEFAULT_SETTINGS.attachmentOrganizationMode;
    const parts = [baseFolder];
    if (mode === "type" || mode === "type-date") {
      parts.push(attachmentTypeFolder(file.extension, this.settings.attachmentTypeMappings));
    }
    if (mode === "date" || mode === "type-date") {
      parts.push(formatAttachmentDate(this.settings.attachmentDateFormat || DEFAULT_SETTINGS.attachmentDateFormat, new Date(file.stat.mtime)));
    }
    return normalizePath(parts.filter(Boolean).join("/"));
  }

  private async uniqueAttachmentPath(preferredPath: string): Promise<string> {
    const normalized = normalizePath(preferredPath);
    if (!this.app.vault.getAbstractFileByPath(normalized)) {
      return normalized;
    }
    const slash = normalized.lastIndexOf("/");
    const dir = slash >= 0 ? normalized.slice(0, slash) : "";
    const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    let index = 1;
    while (true) {
      const candidate = `${dir ? `${dir}/` : ""}${stem}-${index}${ext}`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
      index += 1;
    }
  }

  private async uniqueMarkdownPath(preferredPath: string): Promise<string> {
    const normalized = normalizePath(preferredPath.endsWith(".md") ? preferredPath : `${preferredPath}.md`);
    if (!this.app.vault.getAbstractFileByPath(normalized)) {
      return normalized;
    }
    const slash = normalized.lastIndexOf("/");
    const dir = slash >= 0 ? normalized.slice(0, slash) : "";
    const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const stem = filename.replace(/\.md$/i, "");
    let index = 1;
    while (true) {
      const candidate = `${dir ? `${dir}/` : ""}${stem}-${index}.md`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
      index += 1;
    }
  }

  private async buildHermesVaultIndex(): Promise<HermesNoteIndex[]> {
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => !this.isExcludedPath(file.path))
      .filter((file) => !file.path.startsWith(".obsidian-conflicts/"));
    const index: HermesNoteIndex[] = [];
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      index.push({
        path: file.path,
        title: noteTitle(file, content),
        headings: extractHeadings(content),
        tags: extractTags(content),
        text: `${file.path}\n${content.slice(0, 4000)}`
      });
    }
    return index;
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const parts = normalizePath(folderPath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private scheduleAutoSync(): void {
    if (!this.settings.autoSyncOnChange || !this.settings.token) {
      return;
    }
    if (!this.crypto.isUnlocked()) {
      this.settings.lastSyncStatus = "locked";
      this.saveSettings().catch(() => undefined);
      return;
    }
    if (this.syncPromise) {
      this.queuedAutoSync = true;
      return;
    }
    if (this.autoSyncTimeoutId !== null) {
      window.clearTimeout(this.autoSyncTimeoutId);
    }
    const delay = Math.max(1, this.settings.autoSyncDebounceSeconds) * 1000;
    this.autoSyncTimeoutId = window.setTimeout(() => {
      this.autoSyncTimeoutId = null;
      this.syncNow().catch((error) => new Notice(t(this.settings.language, "notice.syncFailed", { message: error.message })));
    }, delay);
  }

  private isExcludedPath(path: string): boolean {
    const patterns = [...PROTECTED_EXCLUSIONS, ...this.settings.exclusions.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)];
    return patterns.some((pattern) => {
      if (pattern.endsWith("/**")) {
        return path.startsWith(pattern.slice(0, -3));
      }
      return path === pattern || path.startsWith(`${pattern}/`);
    });
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) {
      return;
    }
    const language = this.settings.language;
    const stats = this.settings.lastSyncStats;
    const status = t(language, `settings.status.${this.settings.lastSyncStatus}`);
    this.statusBarEl.empty();
    this.statusBarEl.removeClasses(["is-running", "is-success", "is-error", "is-locked"]);
    this.statusBarEl.addClass(`is-${this.settings.lastSyncStatus}`);
    setIcon(this.statusBarEl, this.iconForStatus());
    this.statusBarEl.createSpan({
      cls: "zk-sync-status-count",
      text: t(language, "statusbar.short", { tracked: stats.trackedNotes })
    });
    this.statusBarEl.title = t(language, "statusbar.tooltip", {
      status,
      tracked: stats.trackedNotes,
      uploaded: stats.uploaded,
      downloaded: stats.downloaded,
      conflicts: stats.conflicts
    });
  }

  private iconForStatus(): string {
    if (this.settings.lastSyncStatus === "running") {
      return "refresh-cw";
    }
    if (this.settings.lastSyncStatus === "success") {
      return "cloud-check";
    }
    if (this.settings.lastSyncStatus === "error") {
      return "cloud-alert";
    }
    if (this.settings.lastSyncStatus === "locked") {
      return "lock";
    }
    return "cloud";
  }
}

type SettingsTabId = "account" | "sync" | "files" | "attachments" | "hermes" | "updates" | "status" | "devices";

class SyncSettingTab extends PluginSettingTab {
  private password = "";
  private activeTab: SettingsTabId = "account";

  constructor(app: App, private readonly plugin: ZeroKnowledgeSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const language = this.plugin.settings.language;

    new Setting(containerEl)
      .setName(t(language, "settings.language.name"))
      .setDesc(t(language, "settings.language.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("en", t(language, "settings.language.en"))
          .addOption("zh", t(language, "settings.language.zh"))
          .setValue(language)
          .onChange(async (value) => {
            this.plugin.settings.language = value as Language;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    this.renderTabNav(containerEl, language);

    if (this.activeTab === "account") {
    new Setting(containerEl)
      .setName(t(language, "settings.serverUrl.name"))
      .setDesc(t(language, "settings.serverUrl.desc"))
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:8080")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.vaultId.name"))
      .setDesc(t(language, "settings.vaultId.desc"))
      .addText((text) =>
        text
          .setPlaceholder("UUID")
          .setValue(this.plugin.settings.vaultId)
          .onChange(async (value) => {
            this.plugin.settings.vaultId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.password.name"))
      .setDesc(t(language, "settings.password.desc"))
      .addText((text) =>
        text
          .setPlaceholder(t(language, "settings.password.placeholder"))
          .setValue(this.password)
          .then((component) => {
            component.inputEl.type = "password";
            component.inputEl.autocomplete = "current-password";
            component.inputEl.spellcheck = false;
          })
          .onChange((value) => {
            this.password = value;
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.register.name"))
      .setDesc(t(language, "settings.register.desc"))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.register.button")).setCta(), t(language, "settings.register.button"), async () => this.register())
      );

    new Setting(containerEl)
      .setName(t(language, "settings.login.name"))
      .setDesc(t(language, "settings.login.desc"))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.login.button")), t(language, "settings.login.button"), async () => this.login())
      );

    new Setting(containerEl)
      .setName(t(language, "settings.unlock.name"))
      .setDesc(t(language, "settings.unlock.desc"))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.unlock.button")), t(language, "settings.unlock.button"), async () => this.withPassword(() => this.plugin.unlock(this.password)))
      );
    }

    if (this.activeTab === "sync") {
    new Setting(containerEl)
      .setName(t(language, "settings.syncMode.name"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("manual", t(language, "settings.syncMode.manual"))
          .addOption("periodic", t(language, "settings.syncMode.periodic"))
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value as PluginSettings["syncMode"];
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.interval.name"))
      .setDesc(t(language, "settings.interval.desc"))
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.syncIntervalSeconds))
          .onChange(async (value) => {
            this.plugin.settings.syncIntervalSeconds = Math.max(10, Number(value) || 30);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.autoSync.name"))
      .setDesc(t(language, "settings.autoSync.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncOnChange)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncOnChange = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.autoSyncDebounce.name"))
      .setDesc(t(language, "settings.autoSyncDebounce.desc"))
      .addText((text) =>
        text
          .setPlaceholder("60")
          .setValue(String(this.plugin.settings.autoSyncDebounceSeconds))
          .onChange(async (value) => {
            this.plugin.settings.autoSyncDebounceSeconds = Math.max(5, Number(value) || 60);
            await this.plugin.saveSettings();
          })
      );
    }

    if (this.activeTab === "hermes") {
    new Setting(containerEl)
      .setName(t(language, "settings.hermesAgent.enabled.name"))
      .setDesc(t(language, "settings.hermesAgent.enabled.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hermesAgentEnabled)
          .onChange(async (value) => {
            this.plugin.settings.hermesAgentEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.hermesAgent.interval.name"))
      .setDesc(t(language, "settings.hermesAgent.interval.desc"))
      .addText((text) =>
        text
          .setPlaceholder("60")
          .setValue(String(this.plugin.settings.hermesAgentIntervalSeconds))
          .onChange(async (value) => {
            this.plugin.settings.hermesAgentIntervalSeconds = Math.max(30, Number(value) || 60);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.hermesAgent.inbox.name"))
      .setDesc(t(language, "settings.hermesAgent.inbox.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.hermesAgentInboxPath)
          .setValue(this.plugin.settings.hermesAgentInboxPath)
          .onChange(async (value) => {
            this.plugin.settings.hermesAgentInboxPath = normalizePath(value.trim() || DEFAULT_SETTINGS.hermesAgentInboxPath);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.hermesAgent.createFolder.name"))
      .setDesc(t(language, "settings.hermesAgent.createFolder.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.hermesAgentCreateFolder)
          .setValue(this.plugin.settings.hermesAgentCreateFolder)
          .onChange(async (value) => {
            this.plugin.settings.hermesAgentCreateFolder = normalizePath(value.trim() || DEFAULT_SETTINGS.hermesAgentCreateFolder);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.hermesAgent.threshold.name"))
      .setDesc(t(language, "settings.hermesAgent.threshold.desc"))
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.hermesAgentAppendScoreThreshold))
          .setValue(String(this.plugin.settings.hermesAgentAppendScoreThreshold))
          .onChange(async (value) => {
            this.plugin.settings.hermesAgentAppendScoreThreshold = Math.max(1, Number(value) || DEFAULT_SETTINGS.hermesAgentAppendScoreThreshold);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.hermesAgent.rules.name"))
      .setDesc(t(language, "settings.hermesAgent.rules.desc"))
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.hermesAgentRoutingRules)
          .onChange(async (value) => {
            this.plugin.settings.hermesAgentRoutingRules = value;
            await this.plugin.saveSettings();
          })
      );
    }

    if (this.activeTab === "updates") {
    new Setting(containerEl)
      .setName(t(language, "settings.updates.current"))
      .setDesc(t(language, "settings.updates.currentDesc", {
        current: this.plugin.manifest.version,
        latest: this.plugin.settings.availableVersion || t(language, "settings.updates.none")
      }));

    new Setting(containerEl)
      .setName(t(language, "settings.updates.auto.name"))
      .setDesc(t(language, "settings.updates.auto.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.updateCheckEnabled)
          .onChange(async (value) => {
            this.plugin.settings.updateCheckEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.updates.repository.name"))
      .setDesc(t(language, "settings.updates.repository.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.updateRepository)
          .setValue(this.plugin.settings.updateRepository)
          .onChange(async (value) => {
            this.plugin.settings.updateRepository = normalizeRepository(value || DEFAULT_SETTINGS.updateRepository);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.updates.branch.name"))
      .setDesc(t(language, "settings.updates.branch.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.updateBranch)
          .setValue(this.plugin.settings.updateBranch)
          .onChange(async (value) => {
            this.plugin.settings.updateBranch = value.trim() || DEFAULT_SETTINGS.updateBranch;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.updates.check.name"))
      .setDesc(t(language, "settings.updates.check.desc", {
        time: this.plugin.settings.lastUpdateCheckAt || t(language, "settings.stats.none")
      }))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.updates.check.button")), t(language, "settings.updates.check.button"), async () => {
          await this.plugin.checkForPluginUpdate();
          this.display();
        })
      )
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.updates.install.button")).setCta(), t(language, "settings.updates.install.button"), async () => {
          await this.plugin.installPluginUpdate();
          this.display();
        })
      );
    }

    if (this.activeTab === "files") {
    new Setting(containerEl)
      .setName(t(language, "settings.selective.name"))
      .setDesc(t(language, "settings.selective.desc"));
    this.addSelectiveToggle(containerEl, "settings.selective.markdown", "syncMarkdown");
    this.addSelectiveToggle(containerEl, "settings.selective.json", "syncJson");
    this.addSelectiveToggle(containerEl, "settings.selective.images", "syncImages");
    this.addSelectiveToggle(containerEl, "settings.selective.documents", "syncDocuments");
    this.addSelectiveToggle(containerEl, "settings.selective.audio", "syncAudio");
    this.addSelectiveToggle(containerEl, "settings.selective.video", "syncVideo");
    this.addSelectiveToggle(containerEl, "settings.selective.archives", "syncArchives");
    this.addSelectiveToggle(containerEl, "settings.selective.other", "syncOtherFiles");
    this.addSelectiveToggle(containerEl, "settings.selective.obsidianConfig", "syncObsidianConfig");

    new Setting(containerEl)
      .setName(t(language, "settings.exclusions.name"))
      .setDesc(t(language, "settings.exclusions.desc"))
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.exclusions)
          .onChange(async (value) => {
            this.plugin.settings.exclusions = value;
            await this.plugin.saveSettings();
          })
      );
    }

    if (this.activeTab === "attachments") {
    new Setting(containerEl)
      .setName(t(language, "settings.manageAttachments.name"))
      .setDesc(t(language, "settings.manageAttachments.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.manageAttachments)
          .onChange(async (value) => {
            this.plugin.settings.manageAttachments = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.attachmentFolder.name"))
      .setDesc(t(language, "settings.attachmentFolder.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.attachmentFolder)
          .setValue(this.plugin.settings.attachmentFolder)
          .onChange(async (value) => {
            this.plugin.settings.attachmentFolder = normalizePath(value.trim() || DEFAULT_SETTINGS.attachmentFolder);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.attachmentMode.name"))
      .setDesc(t(language, "settings.attachmentMode.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("flat", t(language, "settings.attachmentMode.flat"))
          .addOption("type", t(language, "settings.attachmentMode.type"))
          .addOption("date", t(language, "settings.attachmentMode.date"))
          .addOption("type-date", t(language, "settings.attachmentMode.typeDate"))
          .setValue(this.plugin.settings.attachmentOrganizationMode)
          .onChange(async (value) => {
            this.plugin.settings.attachmentOrganizationMode = value as AttachmentOrganizationMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.attachmentDateFormat.name"))
      .setDesc(t(language, "settings.attachmentDateFormat.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.attachmentDateFormat)
          .setValue(this.plugin.settings.attachmentDateFormat)
          .onChange(async (value) => {
            this.plugin.settings.attachmentDateFormat = normalizeDateFormat(value.trim() || DEFAULT_SETTINGS.attachmentDateFormat);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.attachmentTypeMappings.name"))
      .setDesc(t(language, "settings.attachmentTypeMappings.desc"))
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.attachmentTypeMappings)
          .onChange(async (value) => {
            this.plugin.settings.attachmentTypeMappings = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.migration.name"))
      .setDesc(t(language, "settings.migration.desc", {
        time: this.plugin.settings.lastAttachmentMigrationAt || t(language, "settings.stats.none")
      }))
      .addButton((button) =>
        button.setButtonText(t(language, "settings.migration.button")).onClick(() => {
          new Notice(t(language, "notice.actionStarted", { action: t(language, "settings.migration.button") }));
          const count = this.plugin.countUnmanagedAttachments();
          new ConfirmModal(
            this.app,
            t(language, "modal.organize.title"),
            t(language, "modal.organize.desc", { count }),
            t(language, "modal.organize.confirm"),
            t(language, "modal.cancel"),
            async () => {
              await this.plugin.organizeExistingAttachments();
              this.display();
            }
          ).open();
        })
      );

    const orphanCount = this.plugin.settings.orphanAttachments?.length ?? 0;
    new Setting(containerEl)
      .setName(t(language, "settings.orphans.name"))
      .setDesc(t(language, "settings.orphans.desc", {
        time: this.plugin.settings.lastOrphanScanAt || t(language, "settings.stats.none"),
        count: orphanCount
      }))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.orphans.button")), t(language, "settings.orphans.button"), async () => {
          await this.plugin.scanOrphanAttachments();
          this.display();
        })
      )
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.orphans.cleanup")), t(language, "settings.orphans.cleanup"), async () => {
          await this.plugin.cleanupOrphanAttachments();
          this.display();
        })
      );
    if (orphanCount > 0) {
      new Setting(containerEl)
        .setName(this.plugin.settings.orphanAttachments.slice(0, 5).join(", "))
        .setDesc(orphanCount > 5 ? `+${orphanCount - 5}` : "");
    } else if (this.plugin.settings.lastOrphanScanAt) {
      new Setting(containerEl)
        .setName(t(language, "settings.orphans.none"))
        .setDesc("");
    }
    }

    if (this.activeTab === "sync") {
    new Setting(containerEl)
      .setName(t(language, "settings.manual.name"))
      .setDesc(t(language, "settings.manual.desc", { time: this.plugin.settings.lastSync || t(language, "settings.manual.never") }))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.manual.button")).setCta(), t(language, "settings.manual.button"), async () => {
          await this.plugin.syncNow();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.fullSync.name"))
      .setDesc(t(language, "settings.fullSync.desc"))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.fullSync.button")), t(language, "settings.fullSync.button"), async () => {
          await this.plugin.fullResync();
          this.display();
        })
      );
    }

    if (this.activeTab === "hermes") {
    new Setting(containerEl)
      .setName(t(language, "settings.telegram.import.name"))
      .setDesc(t(language, "settings.telegram.import.desc", { count: this.plugin.telegramQueueItems.length }))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.telegram.import.refresh")), t(language, "settings.telegram.import.refresh"), async () => {
          await this.plugin.loadTelegramQueue();
          this.display();
        })
      )
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.telegram.import.button")).setCta(), t(language, "settings.telegram.import.button"), async () => {
          await this.plugin.importTelegramQueue();
          this.display();
        })
      );
    if (this.plugin.telegramQueueItems.length === 0) {
      new Setting(containerEl)
        .setName(t(language, "settings.telegram.import.empty"))
        .setDesc("");
    }
    for (const item of this.plugin.telegramQueueItems.slice(0, 5)) {
      new Setting(containerEl)
        .setName(`${item.created_at} - ${item.target_note_path || "Inbox/Telegram.md"}`)
        .setDesc(previewText(item.merge_content || ""));
    }
    }

    if (this.activeTab === "status") {
    const stats = this.plugin.settings.lastSyncStats;
    const status = t(language, `settings.status.${this.plugin.settings.lastSyncStatus}`);
    new Setting(containerEl)
      .setName(t(language, "settings.status.name"))
      .setDesc(t(language, "settings.status.desc", { status }));
    new Setting(containerEl)
      .setName(t(language, "settings.stats.tracked", { count: stats.trackedNotes }))
      .setDesc(t(language, "settings.stats.uploaded", { count: stats.uploaded }));
    new Setting(containerEl)
      .setName(t(language, "settings.stats.downloaded", { count: stats.downloaded }))
      .setDesc(t(language, "settings.stats.conflicts", { count: stats.conflicts }));
    new Setting(containerEl)
      .setName(t(language, "settings.stats.started", { time: stats.lastStartedAt || t(language, "settings.stats.none") }))
      .setDesc(t(language, "settings.stats.finished", { time: stats.lastFinishedAt || t(language, "settings.stats.none") }));
    if (stats.lastError) {
      new Setting(containerEl)
        .setName(t(language, "settings.stats.error", { message: stats.lastError }))
        .setDesc("");
    }

    new Setting(containerEl)
      .setName(t(language, "settings.versions.name"))
      .setDesc(t(language, "settings.versions.desc"))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.versions.button")), t(language, "settings.versions.button"), async () => {
          await this.plugin.loadActiveFileVersions();
          this.display();
        })
      );
    if (this.plugin.activeFileVersions.length === 0) {
      new Setting(containerEl).setName(t(language, "settings.versions.empty")).setDesc("");
    }
    for (const version of this.plugin.activeFileVersions.slice(0, 8)) {
      new Setting(containerEl)
        .setName(`${version.created_at} - ${version.operation}`)
        .setDesc(`${version.mime_type} ${version.file_size ?? 0} bytes`)
        .addButton((button) =>
          this.bindActionButton(button.setButtonText(t(language, "settings.versions.restore")), t(language, "settings.versions.restore"), async () => {
            await this.plugin.restoreVersion(version.id);
            this.display();
          })
        );
    }

    const conflictRecords = this.plugin.settings.conflictRecords ?? [];
    new Setting(containerEl)
      .setName(t(language, "settings.conflicts.name"))
      .setDesc(conflictRecords.length > 0 ? t(language, "settings.conflicts.desc") : t(language, "settings.conflicts.empty"));
    for (const [index, record] of conflictRecords.slice(0, 8).entries()) {
      new Setting(containerEl)
        .setName(`${record.originalPath} (${record.createdAt})`)
        .setDesc(record.conflictPath)
        .addButton((button) =>
          this.bindActionButton(button.setButtonText(t(language, "settings.conflicts.open")), t(language, "settings.conflicts.open"), async () => {
            const file = this.app.vault.getAbstractFileByPath(record.conflictPath);
            if (file instanceof TFile) {
              await this.app.workspace.getLeaf().openFile(file);
            }
          })
        )
        .addButton((button) =>
          this.bindActionButton(button.setButtonText(t(language, "settings.conflicts.restore")), t(language, "settings.conflicts.restore"), async () => {
            await this.plugin.restoreConflict(index);
            this.display();
          })
        );
    }
    }

    if (this.activeTab === "devices") {
    const deviceTotal = this.plugin.devices.length;
    const revokedDevices = this.plugin.devices.filter((device) => !!device.revoked_at).length;
    const activeDevices = this.plugin.devices.filter((device) => !device.revoked_at).length;
    new Setting(containerEl)
      .setName(t(language, "settings.devices.name"))
      .setDesc(t(language, "settings.devices.desc", {
        total: deviceTotal,
        active: activeDevices,
        revoked: revokedDevices
      }))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.devices.refresh")), t(language, "settings.devices.refresh"), async () => {
          await this.plugin.refreshDevices();
          this.display();
        })
      );
    if (this.plugin.devices.length === 0) {
      new Setting(containerEl)
        .setName(t(language, "settings.devices.empty"))
        .setDesc("");
    }
    for (const device of this.plugin.devices) {
      const flags = [
        device.current ? t(language, "settings.devices.current") : "",
        device.revoked_at ? t(language, "settings.devices.revoked") : ""
      ].filter(Boolean).join(", ");
      new Setting(containerEl)
        .setName(`${device.device_name ?? device.id}${flags ? ` (${flags})` : ""}`)
        .setDesc(t(language, "settings.devices.meta", {
          platform: device.platform ?? "unknown",
          lastSeen: device.last_seen ?? t(language, "settings.stats.none"),
          createdAt: device.created_at,
          id: shortDeviceId(device.id)
        }))
        .addButton((button) => {
          this.bindActionButton(button.setButtonText(t(language, "settings.devices.revoke")).setDisabled(device.current || !!device.revoked_at), t(language, "settings.devices.revoke"), async () => {
            await this.plugin.revokeDevice(device.id);
            this.display();
          });
        });
    }
    }

    if (this.activeTab === "status") {
    const history = this.plugin.settings.syncHistory ?? [];
    new Setting(containerEl)
      .setName(t(language, "settings.history.name"))
      .setDesc(history.length > 0 ? "" : t(language, "settings.history.empty"));
    for (const entry of history.slice(0, 5)) {
      const entryStatus = t(language, `settings.status.${entry.status}`);
      new Setting(containerEl)
        .setName(entry.lastFinishedAt || entry.lastStartedAt || t(language, "settings.stats.none"))
        .setDesc(t(language, "settings.history.desc", {
          time: entry.lastFinishedAt || entry.lastStartedAt || t(language, "settings.stats.none"),
          status: entryStatus,
          uploaded: entry.uploaded,
          downloaded: entry.downloaded,
          conflicts: entry.conflicts
        }));
    }
    }
  }

  private renderTabNav(containerEl: HTMLElement, language: Language): void {
    const navEl = containerEl.createDiv({ cls: "zk-sync-settings-tabs" });
    const tabs: Array<[SettingsTabId, string]> = [
      ["account", "settings.tabs.account"],
      ["sync", "settings.tabs.sync"],
      ["files", "settings.tabs.files"],
      ["attachments", "settings.tabs.attachments"],
      ["hermes", "settings.tabs.hermes"],
      ["updates", "settings.tabs.updates"],
      ["status", "settings.tabs.status"],
      ["devices", "settings.tabs.devices"]
    ];
    for (const [id, labelKey] of tabs) {
      const button = navEl.createEl("button", {
        cls: `zk-sync-settings-tab${this.activeTab === id ? " is-active" : ""}`,
        text: t(language, labelKey)
      });
      button.type = "button";
      button.onclick = () => {
        this.activeTab = id;
        this.display();
      };
    }
  }

  private async register(): Promise<void> {
    await this.withPassword(async () => {
      const response = await this.plugin.api.register(this.app.vault.getName(), this.password, this.deviceName(), this.platform());
      this.plugin.settings.vaultId = response.vault_id;
      this.plugin.settings.deviceId = response.device_id;
      this.plugin.settings.token = response.token;
      await this.plugin.unlock(this.password);
      await this.plugin.saveSettings();
      new Notice(t(this.plugin.settings.language, "notice.registered"));
      this.display();
    });
  }

  private addSelectiveToggle(containerEl: HTMLElement, labelKey: string, settingKey: keyof Pick<PluginSettings, "syncMarkdown" | "syncJson" | "syncImages" | "syncDocuments" | "syncAudio" | "syncVideo" | "syncArchives" | "syncOtherFiles" | "syncObsidianConfig">): void {
    const language = this.plugin.settings.language;
    new Setting(containerEl)
      .setName(t(language, labelKey))
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(this.plugin.settings[settingKey]))
          .onChange(async (value) => {
            this.plugin.settings[settingKey] = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private async login(): Promise<void> {
    await this.withPassword(async () => {
      if (!this.plugin.settings.vaultId) {
        throw new Error(t(this.plugin.settings.language, "error.vaultIdRequired"));
      }
      const response = await this.plugin.api.login(this.plugin.settings.vaultId, this.password, this.deviceName(), this.platform());
      this.plugin.settings.deviceId = response.device_id;
      this.plugin.settings.token = response.token;
      await this.plugin.unlock(this.password);
      await this.plugin.saveSettings();
      new Notice(t(this.plugin.settings.language, "notice.loggedIn"));
      this.display();
    });
  }

  private async withPassword(action: () => Promise<void>): Promise<void> {
    try {
      if (!this.password) {
        throw new Error(t(this.plugin.settings.language, "error.passwordRequired"));
      }
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t(this.plugin.settings.language, "notice.prefix", { message }));
    }
  }

  private deviceName(): string {
    return `${this.app.vault.getName()} - ${platformLabel()} - ${deviceDetail()}`;
  }

  private platform(): string {
    return platformLabel();
  }

  private bindActionButton(button: { setButtonText(text: string): unknown; setDisabled(disabled: boolean): unknown; onClick(callback: () => void): unknown }, label: string, action: () => Promise<void>): unknown {
    return button.onClick(async () => {
      const language = this.plugin.settings.language;
      button.setDisabled(true);
      button.setButtonText(t(language, "settings.action.working"));
      new Notice(t(language, "notice.actionStarted", { action: label }));
      try {
        await action();
        new Notice(t(language, "notice.actionComplete", { action: label }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(t(language, "notice.prefix", { message }));
      } finally {
        button.setButtonText(label);
        button.setDisabled(false);
      }
    });
  }
}

class ConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly description: string,
    private readonly confirmLabel: string,
    private readonly cancelLabel: string,
    private readonly onConfirm: () => Promise<void> | void,
    private readonly onCancel: () => Promise<void> | void = () => undefined
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.description });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(this.cancelLabel).onClick(async () => {
          this.settled = true;
          await this.onCancel();
          this.close();
        })
      )
      .addButton((button) =>
        button.setButtonText(this.confirmLabel).setCta().onClick(async () => {
          this.settled = true;
          button.setDisabled(true);
          button.setButtonText("...");
          await this.onConfirm();
          this.close();
        })
      );
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      void this.onCancel();
    }
    this.contentEl.empty();
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

interface HermesRouteDecision {
  action: "append_existing" | "create_new";
  targetPath: string;
  heading: string;
  title: string;
  content: string;
  reason: string;
}

interface HermesNoteIndex {
  path: string;
  title: string;
  headings: string[];
  tags: string[];
  text: string;
}

interface HermesRoutingRule {
  keywords: string[];
  targetFolder: string;
}

interface HermesCandidateScore {
  note: HermesNoteIndex;
  score: number;
  heading: string;
}

function parentFolder(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : "";
}

function shortDeviceId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function previewText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 140)}...` : compact;
}

function parseHermesRoutingRules(text: string): HermesRoutingRule[] {
  return text.split(/\r?\n/)
    .map((line): HermesRoutingRule | null => {
      const [keywordPart, targetPart] = line.split("=>");
      const targetFolder = normalizePath((targetPart ?? "").trim());
      const keywords = (keywordPart ?? "")
        .split(/[,，]/)
        .map((keyword) => keyword.trim().toLowerCase())
        .filter(Boolean);
      return keywords.length > 0 && targetFolder ? { keywords, targetFolder } : null;
    })
    .filter((rule): rule is HermesRoutingRule => rule !== null);
}

function bestHermesRule(content: string, rules: HermesRoutingRule[]): HermesRoutingRule | null {
  const lowered = content.toLowerCase();
  let best: { rule: HermesRoutingRule; score: number } | null = null;
  for (const rule of rules) {
    const score = rule.keywords.reduce((total, keyword) => total + countKeyword(lowered, keyword), 0);
    if (score > 0 && (!best || score > best.score)) {
      best = { rule, score };
    }
  }
  return best?.rule ?? null;
}

function scoreHermesCandidates(content: string, index: HermesNoteIndex[], routeKeywords: string[]): HermesCandidateScore[] {
  const terms = importantTerms(content);
  const loweredContent = content.toLowerCase();
  return index.map((note) => {
    const pathText = note.path.toLowerCase();
    const titleText = note.title.toLowerCase();
    const headingText = note.headings.join(" ").toLowerCase();
    const tagText = note.tags.join(" ").toLowerCase();
    const bodyText = note.text.toLowerCase();
    let score = 0;
    for (const keyword of routeKeywords) {
      if (keyword && (pathText.includes(keyword) || titleText.includes(keyword) || tagText.includes(keyword))) {
        score += 4;
      }
    }
    for (const term of terms) {
      if (titleText.includes(term)) score += 5;
      if (pathText.includes(term)) score += 3;
      if (tagText.includes(term)) score += 3;
      if (headingText.includes(term)) score += 2;
      if (bodyText.includes(term)) score += 1;
    }
    const heading = bestHeadingForContent(loweredContent, note.headings) || "Hermes";
    return { note, score, heading };
  })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
}

function importantTerms(content: string): string[] {
  const matches = content.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const stopwords = new Set([
    "telegram", "https", "http", "www", "com", "the", "and", "for", "with", "from", "this",
    "that", "来源", "消息", "发送者", "采集日期", "链接", "附件", "文字内容"
  ]);
  const counts = new Map<string, number>();
  for (const match of matches) {
    const term = match.replace(/^#+/, "");
    if (stopwords.has(term) || /^\d+$/.test(term) || term.length > 40) {
      continue;
    }
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([term]) => term);
}

function countKeyword(text: string, keyword: string): number {
  if (!keyword) {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(keyword);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(keyword, index + keyword.length);
  }
  return count;
}

function bestHeadingForContent(loweredContent: string, headings: string[]): string {
  let best = "";
  let bestScore = 0;
  for (const heading of headings) {
    const headingTerms = importantTerms(heading);
    const score = headingTerms.reduce((total, term) => total + (loweredContent.includes(term) ? 1 : 0), 0);
    if (score > bestScore) {
      best = heading;
      bestScore = score;
    }
  }
  return best;
}

function appendHermesBlock(original: string, content: string, heading: string): string {
  const block = hermesBlock(content);
  const headingPattern = new RegExp(`(^|\\n)(#{1,6})\\s+${escapeRegExp(heading)}\\s*\\n`, "i");
  const match = headingPattern.exec(original);
  if (!match || typeof match.index !== "number") {
    return `${original.trimEnd()}\n\n## ${heading}\n\n${block}\n`;
  }
  const headingStart = match.index + match[1].length;
  const headingLevel = match[2].length;
  const afterHeading = original.slice(headingStart + match[0].trimStart().length);
  const nextHeading = new RegExp(`\\n#{1,${headingLevel}}\\s+`, "g").exec(afterHeading);
  const insertAt = nextHeading ? headingStart + match[0].trimStart().length + nextHeading.index : original.length;
  return `${original.slice(0, insertAt).trimEnd()}\n\n${block}\n${original.slice(insertAt)}`;
}

function createHermesNote(title: string, content: string, reason: string): string {
  return [
    "---",
    "source: hermes",
    `created: ${new Date().toISOString()}`,
    `route_reason: ${JSON.stringify(reason)}`,
    "---",
    "",
    `# ${title}`,
    "",
    hermesBlock(content),
    ""
  ].join("\n");
}

function hermesBlock(content: string): string {
  return [`### ${new Date().toISOString()}`, "", content.trim()].join("\n");
}

function hermesTitle(content: string, sourceType: string): string {
  const explicit = content.split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line && !line.startsWith(">") && !line.includes("Telegram "));
  const base = explicit || `${sourceType || "Telegram"} ${new Date().toISOString().slice(0, 10)}`;
  return sanitizeFilename(base.slice(0, 48)) || `Hermes ${new Date().toISOString().slice(0, 10)}`;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function noteTitle(file: TFile, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || file.basename;
}

function extractHeadings(content: string): string[] {
  return [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].trim()).filter(Boolean);
}

function extractTags(content: string): string[] {
  const tags = new Set<string>();
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatter) {
    for (const match of frontmatter[1].matchAll(/#?([\p{L}\p{N}_/-]+)/gu)) {
      tags.add(match[1].toLowerCase());
    }
  }
  for (const match of content.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
    tags.add(match[2].toLowerCase());
  }
  return [...tags];
}

function platformLabel(): string {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (platform.includes("win") || userAgent.includes("windows")) {
    return "Windows";
  }
  if (platform.includes("mac") || userAgent.includes("mac os")) {
    return "macOS";
  }
  if (platform.includes("linux") || userAgent.includes("linux")) {
    return "Linux";
  }
  if (userAgent.includes("iphone") || userAgent.includes("ipad")) {
    return "iOS";
  }
  if (userAgent.includes("android")) {
    return "Android";
  }
  return "Obsidian";
}

function deviceDetail(): string {
  const userAgent = navigator.userAgent;
  const match = userAgent.match(/\(([^)]+)\)/);
  if (!match) {
    return "Desktop";
  }
  return match[1]
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
}

function rewriteAttachmentLinks(markdown: string, oldPath: string, oldBasename: string, newPath: string): string {
  const encodedOldPath = encodeURI(oldPath);
  const encodedOldBasename = encodeURI(oldBasename);
  const encodedNewPath = encodeURI(newPath);
  let updated = markdown;
  for (const oldTarget of uniqueStrings([oldPath, oldBasename])) {
    updated = updated.replace(new RegExp(`(!?\\[\\[)${escapeRegExp(oldTarget)}((?:#[^\\]]+)?(?:\\|[^\\]]+)?\\]\\])`, "g"), `$1${newPath}$2`);
  }
  for (const oldTarget of uniqueStrings([oldPath, oldBasename, encodedOldPath, encodedOldBasename])) {
    updated = updated.replace(new RegExp(`(\\[[^\\]]*\\]\\()${escapeRegExp(oldTarget)}((?:#[^\\)]*)?\\))`, "g"), `$1${encodedNewPath}$2`);
    updated = updated.replace(new RegExp(`(!\\[[^\\]]*\\]\\()${escapeRegExp(oldTarget)}((?:#[^\\)]*)?\\))`, "g"), `$1${encodedNewPath}$2`);
  }
  return updated;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attachmentTypeFolder(extension: string, mappingsText: string): string {
  const ext = extension.toLowerCase();
  const mappings = parseAttachmentTypeMappings(mappingsText || DEFAULT_SETTINGS.attachmentTypeMappings);
  for (const [folder, extensions] of mappings) {
    if (extensions.has(ext)) {
      return folder;
    }
  }
  return "files";
}

function parseAttachmentTypeMappings(text: string): Array<[string, Set<string>]> {
  return text.split(/\r?\n/)
    .map((line): [string, Set<string>] | null => {
      const [folderPart, extensionsPart] = line.split(":");
      const folder = normalizePath((folderPart ?? "").trim());
      if (!folder || !extensionsPart) {
        return null;
      }
      const extensions = new Set(extensionsPart
        .split(/[, ]+/)
        .map((extension) => extension.trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean));
      return extensions.size > 0 ? [folder, extensions] : null;
    })
    .filter((entry): entry is [string, Set<string>] => entry !== null);
}

function extractAttachmentTargets(markdown: string): string[] {
  const targets: string[] = [];
  const wikiPattern = /!?\[\[([^|\]#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  const markdownPattern = /!?\[[^\]]*]\(([^)#]+)(?:#[^)]*)?\)/g;
  for (const match of markdown.matchAll(wikiPattern)) {
    targets.push(normalizePath(decodeTarget(match[1].trim())));
  }
  for (const match of markdown.matchAll(markdownPattern)) {
    const target = match[1].trim();
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith("mailto:")) {
      continue;
    }
    targets.push(normalizePath(decodeTarget(target)));
  }
  return uniqueStrings(targets);
}

function decodeTarget(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

function formatAttachmentDate(format: string, date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return normalizePath(normalizeDateFormat(format)
    .replace(/YYYY/g, year)
    .replace(/MM/g, month)
    .replace(/DD/g, day));
}

function normalizeDateFormat(format: string): string {
  return normalizePath(format || DEFAULT_SETTINGS.attachmentDateFormat);
}

function normalizeRepository(value: string): string {
  return value.trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
}

function isNewerVersion(remote: string, current: string): boolean {
  const left = versionParts(remote);
  const right = versionParts(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return false;
}

function versionParts(version: string): number[] {
  return version.split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
}
