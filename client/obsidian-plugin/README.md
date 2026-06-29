# Zero Knowledge Sync Obsidian Plugin

This is the client-side plugin for the sync server in `../../server`.

## Features

- Register and log in to a self-hosted sync server.
- Encrypt files locally before upload.
- Sync Markdown notes and binary attachments.
- Manual sync from the Obsidian status bar icon.
- Periodic sync and delayed auto sync after local file changes.
- Recent sync history in settings.
- Encrypted version history and restore for the active file.
- Tracked conflict copies with open/restore actions.
- Device list and revoke-device support.
- File-type selective sync.
- Obsidian configuration and plugin file sync from `.obsidian`.
- GitHub version check and one-click plugin file update.
- English and Chinese settings UI.
- Optional managed attachment folder with automatic note link rewriting.
- Custom attachment type folder mappings.
- Orphan attachment scanning.
- First-run prompt for organizing existing unmanaged attachments.
- Confirmed orphan cleanup to the system trash.

## Basic Usage

1. Build or copy the plugin files into the vault plugin folder.
2. Enable the plugin in Obsidian.
3. Open the plugin settings page.
4. Set the sync server URL.
5. Register a vault or log in to an existing vault.
6. Unlock with the vault password.
7. Click the status bar sync icon or enable periodic sync.

## Development

```bash
npm install
npm run build
```

Copy these files into an Obsidian vault plugin folder such as:

```text
<vault>/.obsidian/plugins/obsidian-zero-knowledge-sync/
```

Required files:

- `manifest.json`
- `main.js`
- `styles.css`

## Attachment Settings

The plugin can manage attachment locations automatically. When enabled, non-Markdown files are moved into the configured attachment folder and note references are rewritten.

On first use, if unmanaged attachments already exist in the vault, the plugin shows a confirmation prompt before moving anything. You can also run the same action later from the settings page with **Organize existing attachments**. The same action also migrates old managed attachment layouts, for example from `Attachments/images/2026/06/24/photo.png` to `Attachments/images/2026-06-24/photo.png`.

Supported reference styles:

```markdown
![[photo.png]]
[[document.pdf]]
![photo](photo.png)
[document](document.pdf)
```

Settings:

| Setting | Description |
|---|---|
| Manage attachments | Enables automatic attachment moving and link rewriting |
| Attachment folder | Base folder for managed attachments, for example `Attachments` |
| Attachment organization | Chooses how files are grouped under the base folder |
| Attachment date format | Controls the date segment for date-based modes |
| Attachment type folders | Maps extensions to type folders |

Organization modes:

| Mode | Result example |
|---|---|
| Single folder | `Attachments/photo.png` |
| By type | `Attachments/images/photo.png` |
| By date | `Attachments/2026-06-24/photo.png` |
| By type and date | `Attachments/images/2026-06-24/photo.png` |

Date format examples:

| Date format | Result segment |
|---|---|
| `YYYY-MM-DD` | `2026-06-24` |
| `YYYY/MM/DD` | `2026/06/24` |
| `YYYY_MM_DD` | `2026_06_24` |
| `YYYY/MM` | `2026/06` |

For `Attachments/images/2026-06-24/photo.png`, use:

```text
Attachment folder: Attachments
Attachment organization: By type and date
Attachment date format: YYYY-MM-DD
```

Built-in type folders:

| Type folder | Extensions |
|---|---|
| `images` | `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`, `avif` |
| `documents` | `pdf`, `doc`, `docx`, `ppt`, `pptx`, `xls`, `xlsx`, `csv` |
| `audio` | `mp3`, `wav`, `m4a`, `flac`, `ogg`, `aac` |
| `video` | `mp4`, `mov`, `mkv`, `webm`, `avi` |
| `archives` | `zip`, `rar`, `7z`, `tar`, `gz` |
| `files` | Other file types |

Custom type folder mapping format:

```text
images: png, jpg, jpeg, gif, webp
documents: pdf, docx, xlsx
screenshots: png
```

If an extension appears in multiple mappings, the first matching mapping wins.

## Orphan Attachments

The settings page includes an orphan attachment scan. It checks files under the configured attachment folder and reports attachments that are not referenced by Markdown or wiki links in any note.

Cleanup requires a second confirmation and moves orphan attachments to the system trash instead of permanently deleting them.

## Version History, Conflicts, Devices, and Selective Sync

- Current file versions: open a file, click **Load versions**, then restore a selected encrypted version.
- Conflict copies: open or restore tracked conflict copies created by sync conflicts.
- Devices: refresh registered devices and revoke non-current devices.
- Selective sync: enable or disable Markdown, JSON data files, images, documents, audio, video, archives, other files, and Obsidian config/plugin files.
- Obsidian configuration sync: `.obsidian` files are supported so themes, snippets, plugins, hotkeys, and related JSON configuration can follow the vault across devices.
- Protected local files: `.obsidian/plugins/obsidian-zero-knowledge-sync/data.json` and `.obsidian/zero-knowledge-sync-state.json` are always excluded because they contain device-local login/sync state.
- Obsidian config/plugin sync is controlled separately from **Other files**, so plugin `main.js` and `styles.css` can sync even when generic unknown file sync is disabled.

## Plugin Updates

The settings page includes an **Updates** tab. It checks the configured GitHub repository's `client/obsidian-plugin/manifest.json` and compares the remote version with the currently loaded plugin version.

When an update is installed, the plugin downloads and replaces:

- `main.js`
- `manifest.json`
- `styles.css`

Reload Obsidian after installing an update. The updater does not run `git pull`; it works through GitHub raw file downloads so it can run inside the Obsidian plugin sandbox.

## Hermes and Telegram

Telegram intake and Hermes routing are handled by the server-side Hermes Agent. The Obsidian plugin does not poll or consume the Hermes queue; it only syncs the encrypted notes that the server writes.

## Notes

- The plugin encrypts note paths and contents locally before upload.
- The server never receives plaintext note bodies.
- Attachments are encrypted and synced the same way as notes.
- Attachment paths are rewritten before sync, so other devices receive the same organized paths.
- Password-derived key material is currently kept in plugin memory after unlock. OS keychain integration is left as the next hardening step.
