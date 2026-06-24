# Obsidian Sync

Self-hosted Obsidian sync with a FastAPI/PostgreSQL server and an Obsidian desktop plugin.

- `server/` - FastAPI + PostgreSQL sync server
- `client/obsidian-plugin/` - Obsidian plugin
- `Docs/obsidian-sync-design.md` - original product and architecture design

## Current Features

- Account registration and login against the sync server.
- End-to-end encrypted file sync. The server stores encrypted paths and encrypted content only.
- Markdown notes and binary attachments are both supported.
- Manual sync, periodic sync, and automatic sync after local file changes.
- Status bar sync icon in Obsidian with clickable manual sync.
- Sync status and statistics in the plugin settings page.
- English and Chinese UI.
- Configurable attachment management with automatic link rewriting.

## Attachment Management

The plugin can move images, PDFs, audio, video, archives, and other attachments into a managed attachment folder, then rewrite Markdown and Obsidian wiki links to the new paths.

Settings:

| Setting | Description | Example |
|---|---|---|
| Attachment folder | Base folder for managed attachments | `Attachments` |
| Attachment organization | How attachments are grouped under the base folder | Single folder / By type / By date / By type and date |
| Attachment date format | Date path format used by date-based modes | `YYYY/MM/DD` or `YYYY-MM-DD` |

Organization examples:

| Mode | Date format | Result |
|---|---|---|
| Single folder | Not used | `Attachments/photo.png` |
| By type | Not used | `Attachments/images/photo.png` |
| By date | `YYYY-MM-DD` | `Attachments/2026-06-24/photo.png` |
| By type and date | `YYYY/MM/DD` | `Attachments/images/2026/06/24/photo.png` |
| By type and date | `YYYY-MM-DD` | `Attachments/images/2026-06-24/photo.png` |

Built-in type folders:

| Type folder | Extensions |
|---|---|
| `images` | `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`, `avif` |
| `documents` | `pdf`, `doc`, `docx`, `ppt`, `pptx`, `xls`, `xlsx`, `csv` |
| `audio` | `mp3`, `wav`, `m4a`, `flac`, `ogg`, `aac` |
| `video` | `mp4`, `mov`, `mkv`, `webm`, `avi` |
| `archives` | `zip`, `rar`, `7z`, `tar`, `gz` |
| `files` | Other file types |

When a note references `![[photo.png]]` or `![photo](photo.png)`, and the file is moved to a managed attachment path, the plugin rewrites the reference to the final path.

## Useful Future Extensions

High-value improvements to consider next:

| Area | Feature | Value |
|---|---|---|
| Sync visibility | Sync history panel with recent uploads, downloads, skips, and conflicts | Easier troubleshooting without reading logs |
| Attachment control | Custom extension-to-folder mapping | Users can define folders like `assets/screenshots` or `assets/pdfs` |
| Attachment cleanup | Detect orphaned attachments not referenced by any note | Keeps vault storage clean |
| Conflict handling | Visual conflict review and merge UI | Safer than relying only on conflict copies |
| Selective sync | Include/exclude folders from the settings UI | Useful for large vaults, private folders, and generated files |
| Bandwidth | Chunked upload/download for large attachments | More reliable for videos and large PDFs |
| Security | OS keychain integration for the unlock key | Avoids keeping the password workflow too manual |
| Multi-device | Device list and revoke-device support | Lets users remove lost or retired devices |
| Recovery | Export/import encrypted backup package | Adds a clear disaster recovery path |
| Mobile | Mobile-focused compatibility pass | Ensures attachment sync and settings work well on phone/tablet |

## Quick Links

- Server docs: `server/README.md`
- Client docs: `client/obsidian-plugin/README.md`
- 中文插件使用说明: `Docs/plugin-usage.zh.md`
