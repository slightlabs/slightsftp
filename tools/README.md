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

## Load testing

```bash
npm run tools:build
# against its own throwaway server (temp folder, no setup):
node dist-tools/tools/load-test.js --self --protocol sftp --clients 50 --files 5 --size 1MB
# against a running server:
node dist-tools/tools/load-test.js --host sftp.example.com --port 2222 --user load --password '…' --clients 100 --size 10MB
```

Each client uploads, downloads and verifies (SHA-256) its files; the run reports aggregate
throughput, p50 / p95 / max per-file latency and failures, and exits non-zero on any error.
Reference run (laptop, load generator and server in one process, loopback):

| Scenario | Result |
| --- | --- |
| SFTP, 50 clients × 5 × 1 MB | 500 transfers, 0 failed, 45 MB/s, upload p95 1.7 s |
| SFTP, 8 clients × 100 MB | 16 transfers, 0 failed, 57 MB/s, peak RSS 201 MB (streams, no buffering) |
| FTP, 30 clients × 5 × 1 MB | 300 transfers, 0 failed, 63 MB/s, p95 < 0.5 s |
