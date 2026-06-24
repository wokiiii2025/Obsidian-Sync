import { App, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, setIcon } from "obsidian";
import { SyncApi } from "./api";
import { CryptoService } from "./crypto";
import { DEFAULT_SETTINGS } from "./defaults";
import { t } from "./i18n";
import { SyncEngine } from "./sync-engine";
import type { Language, PluginSettings } from "./types";

export default class ZeroKnowledgeSyncPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  crypto = new CryptoService();
  api = new SyncApi(() => this.settings.serverUrl, () => this.settings.token);
  intervalId: number | null = null;
  autoSyncTimeoutId: number | null = null;
  syncPromise: Promise<void> | null = null;
  queuedAutoSync = false;
  organizingAttachmentPaths = new Set<string>();
  statusBarEl: HTMLElement | null = null;

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
    this.registerFileWatchers();
    this.configureInterval();
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
    return !this.isExcludedPath(file.path);
  }

  private async organizeAttachment(file: TAbstractFile, oldPath?: string): Promise<void> {
    if (!this.settings.manageAttachments || !(file instanceof TFile) || file.extension === "md") {
      return;
    }
    if (this.organizingAttachmentPaths.has(file.path) || this.isExcludedPath(file.path) || this.isInAttachmentFolder(file.path)) {
      return;
    }
    const attachmentFolder = normalizePath(this.settings.attachmentFolder || DEFAULT_SETTINGS.attachmentFolder);
    await this.ensureVaultFolder(attachmentFolder);
    const targetPath = await this.uniqueAttachmentPath(`${attachmentFolder}/${file.name}`);
    this.organizingAttachmentPaths.add(file.path);
    try {
      const sourcePath = oldPath ?? file.path;
      await this.app.vault.rename(file, targetPath);
      await this.rewriteAttachmentReferences(sourcePath, targetPath);
      new Notice(t(this.settings.language, "notice.attachmentMoved", { path: targetPath }));
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
        button.setButtonText(t(language, "settings.register.button")).setCta().onClick(async () => {
          await this.register();
        })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.login.name"))
      .setDesc(t(language, "settings.login.desc"))
      .addButton((button) =>
        button.setButtonText(t(language, "settings.login.button")).onClick(async () => {
          await this.login();
        })
      );

    new Setting(containerEl)
      .setName(t(language, "settings.unlock.name"))
      .setDesc(t(language, "settings.unlock.desc"))
      .addButton((button) =>
        button.setButtonText(t(language, "settings.unlock.button")).onClick(async () => {
          await this.withPassword(() => this.plugin.unlock(this.password));
        })
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
        button.setButtonText(t(language, "settings.manual.button")).setCta().onClick(async () => {
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
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
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
