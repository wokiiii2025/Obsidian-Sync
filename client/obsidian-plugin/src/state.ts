import type { Vault } from "obsidian";
import { DEFAULT_STATE, STATE_FILE } from "./defaults";
import type { SyncState } from "./types";

export interface SyncStateRecoveryInfo {
  reason: "empty" | "parse-error";
  backupPath: string;
}

type SyncStateRecoveryHandler = (info: SyncStateRecoveryInfo) => void;

export async function loadSyncState(vault: Vault, onRecover?: SyncStateRecoveryHandler): Promise<SyncState> {
  if (!(await vault.adapter.exists(STATE_FILE))) {
    return structuredClone(DEFAULT_STATE);
  }
  const raw = await vault.adapter.read(STATE_FILE);
  if (!raw.trim()) {
    return recoverSyncState(vault, raw, "empty", onRecover);
  }
  try {
    return JSON.parse(raw) as SyncState;
  } catch {
    return recoverSyncState(vault, raw, "parse-error", onRecover);
  }
}

export async function saveSyncState(vault: Vault, state: SyncState): Promise<void> {
  const content = JSON.stringify(state, null, 2);
  if (!(await vault.adapter.exists(".obsidian"))) {
    await vault.adapter.mkdir(".obsidian");
  }
  await vault.adapter.write(STATE_FILE, content);
}

async function recoverSyncState(
  vault: Vault,
  raw: string,
  reason: SyncStateRecoveryInfo["reason"],
  onRecover?: SyncStateRecoveryHandler
): Promise<SyncState> {
  const state = structuredClone(DEFAULT_STATE);
  const backupPath = `${STATE_FILE}.corrupt-${Date.now()}.bak`;
  await vault.adapter.write(backupPath, raw);
  await saveSyncState(vault, state);
  onRecover?.({ reason, backupPath });
  return state;
}
