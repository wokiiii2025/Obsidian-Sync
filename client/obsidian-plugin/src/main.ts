import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, setIcon } from "obsidian";
import { SyncApi } from "./api";
import { CryptoService } from "./crypto";
import { CONFLICT_DIR, DEFAULT_SETTINGS } from "./defaults";
import { isFileTypeSyncEnabled } from "./file-policy";
import { t } from "./i18n";
import { SyncEngine } from "./sync-engine";
import type { AttachmentOrganizationMode, DeviceInfo, Language, NoteVersionInfo, PluginSettings } from "./types";

export default class ZeroKnowledgeSyncPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  crypto = new CryptoService();
  api = new SyncApi(() => this.settings.serverUrl, () => this.settings.token);
  intervalId: number | null = null;
  autoSyncTimeoutId: number | null = null;
  syncPromise: Promise<void> | null = null;
  queuedAutoSync = false;
  organizingAttachmentPaths = new Set<string>();
  bulkAttachmentOrganizing = false;
  statusBarEl: HTMLElement | null = null;
  activeFileVersions: NoteVersionInfo[] = [];
  devices: DeviceInfo[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();
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
    this.registerFileWatchers();
    this.configureInterval();
    const initialAttachmentTimer = window.setTimeout(() => {
      this.promptInitialAttachmentOrganization().catch((error) => new Notice(t(this.settings.language, "notice.prefix", { message: error.message })));
    }, 1500);
    this.register(() => window.clearTimeout(initialAttachmentTimer));
  }

  onunload(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
    }
    if (this.autoSyncTimeoutId !== null) {
      window.clearTimeout(this.autoSyncTimeoutId);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.configureInterval();
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
      .filter((file) => file.extension !== "md")
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
    return !this.isExcludedPath(file.path) && isFileTypeSyncEnabled(file.extension, this.settings);
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
      .filter((file) => file.extension !== "md")
      .filter((file) => !this.isExcludedPath(file.path))
      .filter((file) => !this.isInAttachmentFolder(file.path));
  }

  private async organizeAttachment(file: TAbstractFile, oldPath?: string): Promise<void> {
    if (!this.settings.manageAttachments || !(file instanceof TFile) || file.extension === "md") {
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
    const patterns = this.settings.exclusions.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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

class SyncSettingTab extends PluginSettingTab {
  private password = "";

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

    new Setting(containerEl)
      .setName(t(language, "settings.selective.name"))
      .setDesc(t(language, "settings.selective.desc"));
    this.addSelectiveToggle(containerEl, "settings.selective.markdown", "syncMarkdown");
    this.addSelectiveToggle(containerEl, "settings.selective.images", "syncImages");
    this.addSelectiveToggle(containerEl, "settings.selective.documents", "syncDocuments");
    this.addSelectiveToggle(containerEl, "settings.selective.audio", "syncAudio");
    this.addSelectiveToggle(containerEl, "settings.selective.video", "syncVideo");
    this.addSelectiveToggle(containerEl, "settings.selective.archives", "syncArchives");
    this.addSelectiveToggle(containerEl, "settings.selective.other", "syncOtherFiles");

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

    new Setting(containerEl)
      .setName(t(language, "settings.manual.name"))
      .setDesc(t(language, "settings.manual.desc", { time: this.plugin.settings.lastSync || t(language, "settings.manual.never") }))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.manual.button")).setCta(), t(language, "settings.manual.button"), async () => {
          await this.plugin.syncNow();
          this.display();
        })
      );

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

    new Setting(containerEl)
      .setName(t(language, "settings.devices.name"))
      .setDesc(t(language, "settings.devices.desc"))
      .addButton((button) =>
        this.bindActionButton(button.setButtonText(t(language, "settings.devices.refresh")), t(language, "settings.devices.refresh"), async () => {
          await this.plugin.refreshDevices();
          this.display();
        })
      );
    for (const device of this.plugin.devices) {
      const flags = [
        device.current ? t(language, "settings.devices.current") : "",
        device.revoked_at ? t(language, "settings.devices.revoked") : ""
      ].filter(Boolean).join(", ");
      new Setting(containerEl)
        .setName(`${device.device_name ?? device.id}${flags ? ` (${flags})` : ""}`)
        .setDesc(`${device.platform ?? ""} ${device.last_seen ?? device.created_at}`)
        .addButton((button) => {
          this.bindActionButton(button.setButtonText(t(language, "settings.devices.revoke")).setDisabled(device.current || !!device.revoked_at), t(language, "settings.devices.revoke"), async () => {
            await this.plugin.revokeDevice(device.id);
            this.display();
          });
        });
    }

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

  private addSelectiveToggle(containerEl: HTMLElement, labelKey: string, settingKey: keyof Pick<PluginSettings, "syncMarkdown" | "syncImages" | "syncDocuments" | "syncAudio" | "syncVideo" | "syncArchives" | "syncOtherFiles">): void {
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
    return `${this.app.vault.getName()} Obsidian`;
  }

  private platform(): string {
    return "obsidian";
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

function parentFolder(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : "";
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
