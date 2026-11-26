# Developer tools

Scripts for local testing. They are compiled to `dist-tools/` (not `dist/`), so they
never ship in the desktop packages or the Docker image.

| Command | What it does |
| --- | --- |
| `npm run setup:testusers` | Creates test users, listeners and folders in `./config.db` |
| `npm run test:client` | Exercises a running server over SFTP and FTP |
| `npm run tools:build && node dist-tools/tools/test-vp-permissions.js` | Checks virtual-path permissions against a running server |
| `npm run tools:build && node dist-tools/tools/server-only.js` | Starts the listeners without any GUI |
