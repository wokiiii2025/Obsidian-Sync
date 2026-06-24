# Zero Knowledge Sync Obsidian Plugin

This is the client-side plugin for the sync server in `../../server`.

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

## Notes

- The plugin encrypts note paths and contents locally before upload.
- The server never receives plaintext note bodies.
- Password-derived key material is currently kept in plugin memory after unlock. OS keychain integration is left as the next hardening step.
