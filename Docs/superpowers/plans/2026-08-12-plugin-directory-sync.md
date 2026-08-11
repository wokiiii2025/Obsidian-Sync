# Plugin Directory Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit plugin-directory sync feature that syncs user-approved Obsidian plugin folders separately from normal file sync while always excluding this sync plugin itself and noise files.

**Architecture:** Extend plugin settings with `syncPluginDirectories` and `pluginDirectories`. File policy decides whether `.obsidian/plugins/<id>/...` is syncable only when enabled and whitelisted. Stats get a separate `pluginFiles` counter so normal synced file counts remain stable.

**Tech Stack:** TypeScript Obsidian plugin, existing `file-policy.ts`, `sync-engine.ts`, `main.ts` settings UI, Node/esbuild test runner.

## Global Constraints

- Keep normal file counts separate from plugin-directory counts.
- Never sync the Zero Knowledge Sync plugin itself, regardless of case.
- Exclude `.DS_Store`, AppleDouble files, and sync state files.
- Use TDD: write failing tests before production code.
- Bump plugin version after implementation.

---

### Task 1: File policy for whitelisted plugin directories

**Files:**
- Modify: `client/obsidian-plugin/src/types.ts`
- Modify: `client/obsidian-plugin/src/defaults.ts`
- Modify: `client/obsidian-plugin/src/file-policy.ts`
- Modify: `client/obsidian-plugin/tests/file-policy.test.ts`

**Interfaces:**
- Produces: `PluginSettings.syncPluginDirectories: boolean`
- Produces: `PluginSettings.pluginDirectories: string`
- Produces: `isPluginDirectoryPath(path: string): boolean`
- Produces: `isPathSyncEnabled(path: string, extension: string, settings: PluginSettings): boolean` plugin whitelist behavior

- [ ] Add tests showing `.obsidian/plugins/dataview/main.js` is disabled by default, enabled when `syncPluginDirectories=true` and `pluginDirectories='dataview'`, and sync plugin itself stays excluded.
- [ ] Run `npm test` and confirm failure.
- [ ] Add settings fields and defaults.
- [ ] Implement plugin ID parsing and path matching in `file-policy.ts`.
- [ ] Run `npm test` and confirm pass.

### Task 2: Separate plugin file statistics

**Files:**
- Modify: `client/obsidian-plugin/src/types.ts`
- Modify: `client/obsidian-plugin/src/defaults.ts`
- Modify: `client/obsidian-plugin/src/sync-engine.ts`
- Modify: `client/obsidian-plugin/src/i18n.ts`

**Interfaces:**
- Produces: `SyncStats.pluginFiles: number`
- Produces: sync completion notice can show plugin count separately.

- [ ] Add tests if feasible through unit-level file-policy; otherwise verify through build.
- [ ] Count plugin files in `SyncEngine.run()` from state paths using `isPluginDirectoryPath`.
- [ ] Keep `trackedNotes` for total tracked records but expose `pluginFiles` separately.
- [ ] Update notices in English and Chinese.
- [ ] Run `npm test` and `npm run build`.

### Task 3: Settings UI controls

**Files:**
- Modify: `client/obsidian-plugin/src/main.ts`
- Modify: `client/obsidian-plugin/src/i18n.ts`

**Interfaces:**
- Consumes: `syncPluginDirectories`, `pluginDirectories` settings.

- [ ] Add Account/Sync settings controls: toggle “同步指定插件目录” and multiline text for plugin IDs.
- [ ] Explain one plugin ID per line and that current sync plugin is always excluded.
- [ ] Save settings on change.
- [ ] Run `npm run build`.

### Task 4: Version, install, verify, commit, push

**Files:**
- Modify: `client/obsidian-plugin/package.json`
- Modify: `client/obsidian-plugin/manifest.json`
- Modify: `client/obsidian-plugin/main.js`

**Interfaces:**
- Produces version `0.1.14`.

- [ ] Bump version to `0.1.14`.
- [ ] Run `npm test` and `npm run build`.
- [ ] Install built files into local Obsidian plugin directory with backup.
- [ ] Commit with message `feat: add explicit plugin directory sync`.
- [ ] Push `main` to GitHub.

## Self-Review

- Spec coverage: plugin whitelist, separate counts, protected plugin exclusion, UI controls, tests, and version bump are covered.
- Placeholder scan: no placeholders remain.
- Type consistency: settings and stats names are consistent across tasks.
