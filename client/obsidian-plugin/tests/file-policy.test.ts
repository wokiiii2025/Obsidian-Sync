import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { isPathExcluded, isPathSyncEnabled } from "../src/file-policy";
import type { PluginSettings } from "../src/types";

function settingsWith(overrides: Partial<PluginSettings>): PluginSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function testProtectedPluginFilesAreExcluded() {
  assert.equal(isPathExcluded(".obsidian/plugins/obsidian-zero-knowledge-sync/main.js", ""), true);
  assert.equal(isPathExcluded(".obsidian/plugins/obsidian-zero-knowledge-sync/manifest.json", ""), true);
  assert.equal(isPathExcluded(".obsidian/plugins/obsidian-zero-knowledge-sync/styles.css", ""), true);
  assert.equal(isPathExcluded(".obsidian/plugins/Obsidian-Zero-Knowledge-Sync/main.js", ""), true);
}

function testStateAndConflictFilesAreExcluded() {
  assert.equal(isPathExcluded(".obsidian/zero-knowledge-sync-state.json", ""), true);
  assert.equal(isPathExcluded(".obsidian/zero-knowledge-sync-state.json.bak-20260812-005917", ""), true);
  assert.equal(isPathExcluded(".obsidian-conflicts/example.md-123", ""), true);
}

function testSystemNoiseFilesAreExcluded() {
  assert.equal(isPathExcluded(".DS_Store", ""), true);
  assert.equal(isPathExcluded(".obsidian/.DS_Store", ""), true);
  assert.equal(isPathExcluded(".obsidian/plugins/.DS_Store", ""), true);
}

function testUserExclusionsAreRespected() {
  assert.equal(isPathExcluded("Private/note.md", "Private/**"), true);
  assert.equal(isPathExcluded("Public/note.md", "Private/**"), false);
}

function testPluginDirectoriesAreDisabledByDefault() {
  const settings = settingsWith({});
  assert.equal(isPathSyncEnabled(".obsidian/plugins/dataview/main.js", "js", settings), false);
}

function testWhitelistedPluginDirectoriesCanSync() {
  const settings = settingsWith({
    syncPluginDirectories: true,
    pluginDirectories: "dataview\ncalendar"
  });
  assert.equal(isPathSyncEnabled(".obsidian/plugins/dataview/main.js", "js", settings), true);
  assert.equal(isPathSyncEnabled(".obsidian/plugins/calendar/data.json", "json", settings), true);
  assert.equal(isPathSyncEnabled(".obsidian/plugins/templater-obsidian/main.js", "js", settings), false);
}

function testSyncPluginItselfNeverSyncs() {
  const settings = settingsWith({
    syncPluginDirectories: true,
    pluginDirectories: "obsidian-zero-knowledge-sync\nObsidian-Zero-Knowledge-Sync"
  });
  assert.equal(isPathExcluded(".obsidian/plugins/Obsidian-Zero-Knowledge-Sync/main.js", ""), true);
  assert.equal(isPathSyncEnabled(".obsidian/plugins/Obsidian-Zero-Knowledge-Sync/main.js", "js", settings), false);
}

testProtectedPluginFilesAreExcluded();
testStateAndConflictFilesAreExcluded();
testSystemNoiseFilesAreExcluded();
testUserExclusionsAreRespected();
testPluginDirectoriesAreDisabledByDefault();
testWhitelistedPluginDirectoriesCanSync();
testSyncPluginItselfNeverSyncs();
