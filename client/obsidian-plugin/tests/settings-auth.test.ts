import { strict as assert } from "node:assert";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { applyVaultIdInput } from "../src/settings-auth";
import type { PluginSettings } from "../src/types";

function cloneSettings(): PluginSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

{
  const settings = cloneSettings();
  settings.vaultId = "old-vault";
  settings.deviceId = "old-device";
  settings.token = "old-token";
  settings.lastSync = "2026-08-04T06:35:59.457562Z";
  settings.lastSyncStatus = "success";

  const changed = applyVaultIdInput(settings, " new-vault ");

  assert.equal(changed, true, "changed vault id should report auth reset");
  assert.equal(settings.vaultId, "new-vault");
  assert.equal(settings.deviceId, "");
  assert.equal(settings.token, "");
  assert.equal(settings.lastSync, "");
  assert.equal(settings.lastSyncStatus, "idle");
}

{
  const settings = cloneSettings();
  settings.vaultId = "same-vault";
  settings.deviceId = "device";
  settings.token = "token";
  settings.lastSync = "2026-08-04T06:35:59.457562Z";
  settings.lastSyncStatus = "success";

  const changed = applyVaultIdInput(settings, " same-vault ");

  assert.equal(changed, false, "same vault id should keep auth");
  assert.equal(settings.deviceId, "device");
  assert.equal(settings.token, "token");
  assert.equal(settings.lastSync, "2026-08-04T06:35:59.457562Z");
  assert.equal(settings.lastSyncStatus, "success");
}

