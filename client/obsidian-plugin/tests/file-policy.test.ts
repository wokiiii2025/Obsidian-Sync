import assert from "node:assert/strict";
import { isPathExcluded } from "../src/file-policy";

function testProtectedPluginFilesAreExcluded() {
  assert.equal(isPathExcluded(".obsidian/plugins/obsidian-zero-knowledge-sync/main.js", ""), true);
  assert.equal(isPathExcluded(".obsidian/plugins/obsidian-zero-knowledge-sync/manifest.json", ""), true);
  assert.equal(isPathExcluded(".obsidian/plugins/obsidian-zero-knowledge-sync/styles.css", ""), true);
}

function testStateAndConflictFilesAreExcluded() {
  assert.equal(isPathExcluded(".obsidian/zero-knowledge-sync-state.json", ""), true);
  assert.equal(isPathExcluded(".obsidian-conflicts/example.md-123", ""), true);
}

function testUserExclusionsAreRespected() {
  assert.equal(isPathExcluded("Private/note.md", "Private/**"), true);
  assert.equal(isPathExcluded("Public/note.md", "Private/**"), false);
}

testProtectedPluginFilesAreExcluded();
testStateAndConflictFilesAreExcluded();
testUserExclusionsAreRespected();
