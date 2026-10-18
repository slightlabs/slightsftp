# Changelog

## v1.2.0 — 2026-10-19

### Security
- **SFTP and FTP path traversal fixed.** Clients could use `..` to list and download
  files outside their virtual root (including `config.db`). Paths are now normalised and
  confined to the user's virtual paths on both protocols.
- **File browser traversal fixed** in the web API (`/api/files/browse`) and the desktop
  `browse-files` / `download-file` handlers.
- **GUI script injection fixed.** File names, paths, usernames and other server data are
  now HTML-escaped before rendering. With `nodeIntegration` enabled, a malicious file name
  uploaded over FTP/SFTP could previously execute code in the admin dashboard.

### Fixes
- Users created or given a new password from the **web GUI** could never log in: the
  password was hashed twice. The same bug broke the default `admin` login of a fresh
  `web-only` install.
- SFTP uploads failed for users without a listener-level permission row; WRITE now honours
  the access granted when the file was opened. Append-only users can open files in append mode.
- Saving a user in the **Edit User** dialog silently removed download (Read) permission and
  could never turn "List Directories" off. A *Read Files* permission was added to the dialog.
- **Edit Port** in the listener dialog never worked (the listener id was not filled in).
  In the desktop app a running listener is now restarted on its new port.
- The web GUI's Settings, Activity Log maintenance, File download, folder picker and
  Edit User / Edit Listener actions failed with "Unknown IPC channel"; all are now
  backed by REST endpoints.
- Web GUI logout now returns to the login page.
- Server (FTP/SFTP) activity is pushed live to web GUI clients over WebSocket.
- Starting the web GUI server on a busy port now fails cleanly instead of hanging (and
  could crash the desktop app).
- Desktop app: logging in no longer leaks hidden login windows, never stacks a second
  dashboard, and no longer adds a duplicate tray icon on every login.
- Default listeners use non-privileged ports again (SFTP 2222, FTP 2121) and old
  development databases are migrated.
- *Help → About* shows the real application version.

### Testing
- New true end-to-end suite: web API → live SFTP/FTP listeners → real clients.
- The Electron main process (`main.ts`) is now tested with a real backend (all IPC handlers).
- The real dashboard (`index.html` + `renderer.js`) and login window are tested in jsdom.
- Contract tests keep the GUI, the Electron IPC handlers, the preload whitelist and the
  web-mode IPC shim in sync.
- Playwright GUI suites drive the real web GUI in Chromium and the real Electron app.
- CI runs the GUI suites; releases are only built after the whole test suite passes.
