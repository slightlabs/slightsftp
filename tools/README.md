# Developer tools

Scripts for local testing. They are compiled to `dist-tools/` (not `dist/`), so they
never ship in the desktop packages or the Docker image.

| Command | What it does |
| --- | --- |
| `npm run setup:testusers` | Creates test users, listeners and folders in `./config.db` |
| `npm run test:client` | Exercises a running server over SFTP and FTP |
| `npm run tools:build && node dist-tools/tools/test-vp-permissions.js` | Checks virtual-path permissions against a running server |
| `npm run tools:build && node dist-tools/tools/server-only.js` | Starts the listeners without any GUI |
| `node tools/convert-icon.js` | Regenerates `build/icon.ico` (Windows installer icon) from `assets/icon.png` |
| `tools/setup-icon.ps1` | Windows: builds all icon formats from `assets/icon-source.png` |
| `npm run test:auto` | Windows: starts a server, runs the test client against it, stops it (`tools/run-tests-with-server.ps1`) |
