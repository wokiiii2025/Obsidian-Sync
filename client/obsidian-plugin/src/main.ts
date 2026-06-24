import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
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

  async onload(): Promise<void> {
    await this.loadSettings();
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
        new Notice(t(this.settings.language, "notice.locked"));
      }
    });
    this.configureInterval();
  }

  onunload(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.configureInterval();
  }

  async unlock(password: string): Promise<void> {
    await this.crypto.unlock(password);
    new Notice(t(this.settings.language, "notice.unlocked"));
  }

  async syncNow(): Promise<void> {
    const engine = new SyncEngine(this.app.vault, this.settings, this.api, this.crypto, () => this.saveSettings());
    await engine.run();
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
