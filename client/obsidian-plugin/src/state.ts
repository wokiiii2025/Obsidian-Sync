import type { Vault } from "obsidian";
import { DEFAULT_STATE, STATE_FILE } from "./defaults";
import type { SyncState } from "./types";

export async function loadSyncState(vault: Vault): Promise<SyncState> {
  if (!(await vault.adapter.exists(STATE_FILE))) {
    return structuredClone(DEFAULT_STATE);
  }
  const raw = await vault.adapter.read(STATE_FILE);
  return JSON.parse(raw) as SyncState;
}

export async function saveSyncState(vault: Vault, state: SyncState): Promise<void> {
  const content = JSON.stringify(state, null, 2);
  if (!(await vault.adapter.exists(".obsidian"))) {
    await vault.adapter.mkdir(".obsidian");
  }
  await vault.adapter.write(STATE_FILE, content);
}
