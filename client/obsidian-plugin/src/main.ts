import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { SyncApi } from "./api";
import { CryptoService } from "./crypto";
import { DEFAULT_SETTINGS } from "./defaults";
import { SyncEngine } from "./sync-engine";
import type { PluginSettings } from "./types";

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
      name: "Sync now",
      callback: () => this.syncNow()
    });
    this.addCommand({
      id: "zero-knowledge-sync-lock",
      name: "Lock sync password",
      callback: () => {
        this.crypto.lock();
        new Notice("Zero Knowledge Sync locked.");
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
    new Notice("Zero Knowledge Sync unlocked.");
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
      this.syncNow().catch((error) => new Notice(`Zero Knowledge Sync failed: ${error.message}`));
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

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Sync API base URL.")
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
      .setName("Vault ID")
      .setDesc("Filled after registration. Keep this to log in on another device.")
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
      .setName("Vault password")
      .setDesc("Used locally for encryption and server login.")
      .addText((text) =>
        text
          .setPlaceholder("Password")
          .setValue(this.password)
          .onChange((value) => {
            this.password = value;
          })
      );

    new Setting(containerEl)
      .setName("Register this vault")
      .setDesc("Creates a new server vault and stores the returned token.")
      .addButton((button) =>
        button.setButtonText("Register").setCta().onClick(async () => {
          await this.register();
        })
      );

    new Setting(containerEl)
      .setName("Login this device")
      .setDesc("Use an existing vault ID and password to register this device.")
      .addButton((button) =>
        button.setButtonText("Login").onClick(async () => {
          await this.login();
        })
      );

    new Setting(containerEl)
      .setName("Unlock encryption")
      .setDesc("Derives the local encryption key for this Obsidian session.")
      .addButton((button) =>
        button.setButtonText("Unlock").onClick(async () => {
          await this.withPassword(() => this.plugin.unlock(this.password));
        })
      );

    new Setting(containerEl)
      .setName("Sync mode")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("manual", "Manual only")
          .addOption("periodic", "Periodic")
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value as PluginSettings["syncMode"];
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Seconds. Used only in periodic mode.")
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
      .setName("Exclusions")
      .setDesc("One path or simple folder pattern per line.")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.exclusions)
          .onChange(async (value) => {
            this.plugin.settings.exclusions = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Manual sync")
      .setDesc(`Last sync: ${this.plugin.settings.lastSync || "never"}`)
      .addButton((button) =>
        button.setButtonText("Sync now").setCta().onClick(async () => {
          await this.plugin.syncNow();
          this.display();
        })
      );
  }

  private async register(): Promise<void> {
    await this.withPassword(async () => {
      const response = await this.plugin.api.register(this.app.vault.getName(), this.password, this.deviceName(), this.platform());
      this.plugin.settings.vaultId = response.vault_id;
      this.plugin.settings.deviceId = response.device_id;
      this.plugin.settings.token = response.token;
      await this.plugin.unlock(this.password);
      await this.plugin.saveSettings();
      new Notice("Zero Knowledge Sync registered.");
      this.display();
    });
  }

  private async login(): Promise<void> {
    await this.withPassword(async () => {
      if (!this.plugin.settings.vaultId) {
        throw new Error("Vault ID is required");
      }
      const response = await this.plugin.api.login(this.plugin.settings.vaultId, this.password, this.deviceName(), this.platform());
      this.plugin.settings.deviceId = response.device_id;
      this.plugin.settings.token = response.token;
      await this.plugin.unlock(this.password);
      await this.plugin.saveSettings();
      new Notice("Zero Knowledge Sync logged in.");
      this.display();
    });
  }

  private async withPassword(action: () => Promise<void>): Promise<void> {
    try {
      if (!this.password) {
        throw new Error("Password is required");
      }
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Zero Knowledge Sync: ${message}`);
    }
  }

  private deviceName(): string {
    return `${this.app.vault.getName()} Obsidian`;
  }

  private platform(): string {
    return "obsidian";
  }
}
