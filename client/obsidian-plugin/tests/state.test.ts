import assert from "node:assert/strict";
import { loadSyncState } from "../src/state";

type StoredFiles = Record<string, string>;

function fakeVault(files: StoredFiles) {
  return {
    adapter: {
      async exists(path: string) {
        return Object.prototype.hasOwnProperty.call(files, path);
      },
      async read(path: string) {
        return files[path];
      },
      async write(path: string, content: string) {
        files[path] = content;
      },
      async mkdir(path: string) {
        files[`${path}/`] = "";
      }
    }
  };
}

async function testEmptyStateIsBackedUpAndRecovered() {
  const files: StoredFiles = {
    ".obsidian/zero-knowledge-sync-state.json": ""
  };
  const recoveries: Array<{ reason: string; backupPath: string }> = [];

  const state = await loadSyncState(fakeVault(files) as never, (info) => recoveries.push(info));

  assert.deepEqual(state, { notes: {} });
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].reason, "empty");
  assert.match(recoveries[0].backupPath, /^\.obsidian\/zero-knowledge-sync-state\.json\.corrupt-\d+\.bak$/);
  assert.equal(files[recoveries[0].backupPath], "");
  assert.equal(files[".obsidian/zero-knowledge-sync-state.json"], '{\n  "notes": {}\n}');
}

async function testInvalidStateIsBackedUpAndRecovered() {
  const files: StoredFiles = {
    ".obsidian/zero-knowledge-sync-state.json": "{bad json"
  };
  const recoveries: Array<{ reason: string; backupPath: string }> = [];

  const state = await loadSyncState(fakeVault(files) as never, (info) => recoveries.push(info));

  assert.deepEqual(state, { notes: {} });
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].reason, "parse-error");
  assert.equal(files[recoveries[0].backupPath], "{bad json");
  assert.equal(files[".obsidian/zero-knowledge-sync-state.json"], '{\n  "notes": {}\n}');
}

await testEmptyStateIsBackedUpAndRecovered();
await testInvalidStateIsBackedUpAndRecovered();
