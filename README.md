# Obsidian Sync

Self-hosted Obsidian sync with a FastAPI/PostgreSQL server and an Obsidian desktop plugin.

- `server/` - FastAPI + PostgreSQL sync server
- `server/telegram-bot/` - Telegram webhook intake service
- `client/obsidian-plugin/` - Obsidian plugin
- `Docs/obsidian-sync-design.md` - original product and architecture design

## Current Features

- Account registration and login against the sync server.
- End-to-end encrypted file sync. The server stores encrypted paths and encrypted content only.
- Markdown notes and binary attachments are both supported.
- Manual sync, periodic sync, and automatic sync after local file changes.
- Status bar sync icon in Obsidian with clickable manual sync.
- Sync status and statistics in the plugin settings page.
- Recent sync history in the plugin settings page.
- Encrypted version history with restore for the active file.
- Tracked conflict copies with open/restore actions.
- Device list and revoke-device support.
- File-type selective sync.
- English and Chinese UI.
- Configurable attachment management with automatic link rewriting.
- Custom attachment type folder mappings.
- Orphan attachment scanning.
- First-run confirmation before organizing existing attachments.
- Confirmed orphan cleanup to the system trash.
- Telegram Bot intake service for queuing channel/group messages into the Hermes queue.

## Attachment Management

The plugin can move images, PDFs, audio, video, archives, and other attachments into a managed attachment folder, then rewrite Markdown and Obsidian wiki links to the new paths.

Settings:

| Setting | Description | Example |
|---|---|---|
| Attachment folder | Base folder for managed attachments | `Attachments` |
| Attachment organization | How attachments are grouped under the base folder | Single folder / By type / By date / By type and date |
| Attachment date format | Date path format used by date-based modes | `YYYY/MM/DD` or `YYYY-MM-DD` |
| Attachment type folders | Extension-to-folder mapping | `images: png, jpg, webp` |

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

On first use, the plugin prompts before organizing existing unmanaged attachments. The settings page also includes manual organize, orphan scan, and confirmed cleanup actions. Cleanup moves orphan files to the system trash instead of permanently deleting them.

## Useful Future Extensions

High-value improvements to consider next:

| Area | Feature | Value |
|---|---|---|
| Selective sync | Include/exclude folders from the settings UI | Useful for large vaults, private folders, and generated files |
| Bandwidth | Chunked upload/download for large attachments | More reliable for videos and large PDFs |
| Security | OS keychain integration for the unlock key | Avoids keeping the password workflow too manual |
| Recovery | Export/import encrypted backup package | Adds a clear disaster recovery path |
| Mobile | Mobile-focused compatibility pass | Ensures attachment sync and settings work well on phone/tablet |

## Quick Links

- Server docs: `server/README.md`
- Client docs: `client/obsidian-plugin/README.md`
- 中文插件使用说明: `Docs/plugin-usage.zh.md`
