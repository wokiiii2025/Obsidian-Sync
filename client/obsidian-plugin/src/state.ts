import type { TFile, Vault } from "obsidian";
import { DEFAULT_STATE, STATE_FILE } from "./defaults";
import type { SyncState } from "./types";

export async function loadSyncState(vault: Vault): Promise<SyncState> {
  const file = vault.getAbstractFileByPath(STATE_FILE);
  if (!file) {
    return structuredClone(DEFAULT_STATE);
  }
  if (!("extension" in file)) {
    return structuredClone(DEFAULT_STATE);
  }
  const raw = await vault.read(file as TFile);
  return JSON.parse(raw) as SyncState;
}

export async function saveSyncState(vault: Vault, state: SyncState): Promise<void> {
  const existing = vault.getAbstractFileByPath(STATE_FILE);
  const content = JSON.stringify(state, null, 2);
  if (existing && "extension" in existing) {
    await vault.modify(existing as TFile, content);
    return;
  }
  await vault.create(STATE_FILE, content);
}
