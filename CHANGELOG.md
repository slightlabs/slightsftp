# Changelog

## v1.7.0 — 2026-10-19

### New
- **Cloud storage folders**: point a user's virtual path at an Amazon S3 bucket (or an
  S3-compatible service such as MinIO, Wasabi, Cloudflare R2 or Backblaze B2) or an Azure
  Blob container. SFTP, FTP, the file portal, share links and the admin file browser all
  work there. Add connections in the new *Cloud Storage* panel (with *Test connection*),
  then choose the bucket as the *Storage* of a virtual path. Quotas, speed limits,
  checksums and webhooks work as for local folders.
- REST API: `/api/storage`. The API documentation now also covers API tokens, the recycle
  bin, audit export, backup / restore, update checks and directory sign-in.

### Security
- **FTP permissions for relative paths**: after changing into a read-only folder, FTP
  checked file names relative to that folder against the *root* folder's permissions, so
  uploads, deletes and renames there could be allowed. Upgrade is recommended if you give
  FTP users folders with different permissions.
- The desktop app now runs on **Electron 44** (was Electron 28, which no longer receives
  security fixes).

### Fixes
- FTP now maps nested virtual paths (e.g. `/reports` inside `/`) to the right folder.
- SFTP file handles are closed when a client disconnects without closing them.
- The features page no longer describes the old password hashing.

### Upgrade notes
- Running from source or with `npm` needs Node.js 22.12 or newer (installers and the
  Docker image include their own runtime).
- In a cloud folder, deletes are permanent (the recycle bin covers local folders), and
  files cannot be moved between a bucket and a local folder with a single rename.
- Configuration backups include cloud storage access keys: store them safely.

## v1.6.0 — 2026-10-19

### New
- **LDAP / Active Directory sign-in**: users can sign in with their directory password over
  SFTP, FTP, the web GUI, the file portal and the desktop app (Security → Directory Sign-in).
- **macOS installer** (`.dmg`, Intel and Apple Silicon). It is not signed: the first time,
  right-click the app and choose *Open*.
- **First-run setup wizard**: share a first folder with a user in one step on a new install.
- **Dark mode** for the dashboard (follows the system, or pick with the 🌓 button).
- **Update notifications**: the dashboard shows when a newer release is available.

### Fixes
- Release builds no longer fail on extra build-record artifacts.

## v1.5.0 — 2026-10-19

### New
- **Docker image**: `ghcr.io/slightlabs/slightsftp` runs the headless server with the web
  admin GUI; data lives in the `/data` volume (see `docker-compose.yml`). FTP passive mode
  can be set with `FTP_PASV_URL`, `FTP_PASV_MIN`, `FTP_PASV_MAX`.
- **Storage quotas** per user, enforced over SFTP, FTP, the portal and share links.
- **Speed limits** per user (upload / download KB/s), shared across all their sessions.
- **Recycle bin**: deleted files can be restored by the user (portal) or an admin, and
  are purged after a retention period (default 30 days).
- **API tokens**: personal access tokens (`Authorization: Bearer sst_…`) for scripts.
- **Backup & restore** of the whole configuration, including the SFTP host key and TLS
  certificate.
- **Audit export**: forward activity to syslog / SIEM (RFC 5424, UDP or TCP) and record a
  SHA-256 checksum of every uploaded file.

### Upgrade notes
- The recycle bin is on by default; deleted files now go there. Turn it off or change the
  retention in *Recycle Bin*.

## v1.4.0 — 2026-10-19

### Security
- **SFTP public-key sign-in now verifies signatures.** Earlier versions accepted any
  signature for a listed public key, so anyone who knew a user's *public* key could sign
  in as that user. Upgrade is strongly recommended if you use key-based logins.
- **Brute-force protection**: repeated failed logins from one address (SFTP, FTP, web
  GUI, file portal, share-link passwords) ban it temporarily. Ban list with Unban in the
  new Security panel; loopback is never banned by default.
- **Two-factor sign-in (TOTP)** for the desktop app, web GUI and file portal, with any
  authenticator app. Admins can reset a user's 2FA.
- **Per-user IP allow-lists**: restrict accounts to addresses / CIDR ranges.

### New
- **Webhooks**: notify Slack, Teams or any URL on uploads, downloads, deletes, sign-ins,
  failed sign-ins and share links — with user / path filters, HMAC signatures and retries.
- **Live transfers**: files in progress with speed, and per-session totals, on the
  dashboard and in Active Sessions.
- **OpenSSH public keys**: paste `authorized_keys` lines (Ed25519, RSA, ECDSA), several
  per user.

### Upgrade notes
- Existing single base64 public keys keep working; they are shown in OpenSSH format
  after the user is next saved.
- Brute-force protection is on by default (5 failures in 10 minutes → 15 minute ban);
  adjust it in Security.

## v1.3.0 — 2026-10-19

### New
- **Browser file portal** at `/files`: users with portal access browse, upload
  (button or drag and drop, with progress), download, create folders, rename and
  delete — limited by the same virtual-path permissions as SFTP/FTP.
- **Share links**: expiring, optionally password-protected download links for files
  and folders, upload-only "request files" links, download limits, QR codes,
  "My links" with revoke, and a Shared Links panel for admins.
- **HTTPS for the web GUI** with an automatically generated certificate (or your own).
- **FTPS (explicit TLS)** per FTP listener: off, optional or required.
- **Forced password change** when signing in with the default password or when an
  admin requires it ("Require password change at next GUI login").
- SFTP **host key fingerprint** shown on each SFTP listener.
- Real **REST API documentation** on the website.
- The activity log records completed **uploads and downloads with their size** for
  SFTP and FTP (previously SFTP only logged "OPEN").

### Security
- Passwords are stored as **salted scrypt** hashes; existing SHA-256 hashes are
  upgraded automatically at the next successful login.
- The SFTP host key is now persistent. Previously every restart created a new key,
  so clients warned that the server identity had changed.
- User APIs no longer return password hashes.

### Upgrade notes
- The first sign-in with `admin` / `admin123` now asks for a new password.
- SFTP clients will see a new host key once after upgrading; it stays stable from
  then on (compare it with the fingerprint shown on the listener).
- The web portal is off for existing users; enable it per user in Edit User.

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
