# Zero Knowledge Sync Obsidian Plugin

This is the client-side plugin for the sync server in `../../server`.

## Features

- Register and log in to a self-hosted sync server.
- Encrypt files locally before upload.
- Sync Markdown notes and binary attachments.
- Manual sync from the Obsidian status bar icon.
- Periodic sync and delayed auto sync after local file changes.
- English and Chinese settings UI.
- Optional managed attachment folder with automatic note link rewriting.

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
| `YYYY/MM/DD` | `2026/06/24` |
| `YYYY-MM-DD` | `2026-06-24` |
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

## Notes

- The plugin encrypts note paths and contents locally before upload.
- The server never receives plaintext note bodies.
- Attachments are encrypted and synced the same way as notes.
- Attachment paths are rewritten before sync, so other devices receive the same organized paths.
- Password-derived key material is currently kept in plugin memory after unlock. OS keychain integration is left as the next hardening step.
