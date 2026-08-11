import type { PluginSettings } from "./types";

export function applyVaultIdInput(settings: PluginSettings, input: string): boolean {
  const nextVaultId = input.trim();
  if (nextVaultId === settings.vaultId) {
    return false;
  }
  settings.vaultId = nextVaultId;
  settings.deviceId = "";
  settings.token = "";
  settings.lastSync = "";
  settings.lastSyncStatus = "idle";
  settings.lastSyncStats.lastError = "";
  return true;
}

