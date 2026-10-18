# SLightSFTP Roadmap

**Positioning:** the easiest *secure* file server you can run on a desktop — install, click,
share. Free SFTP (FileZilla Server keeps SFTP for Pro), point-and-click setup (SFTPGo is
config-file driven) and no licence fee (CrushFTP).

Items are implemented in order. Each ships with tests and is marked here when done.

## Phase 1 — Credibility (make the website's promises true)

- [x] **Salted password hashing** — scrypt with per-user salt; legacy SHA-256 hashes upgraded transparently on next successful login; one verification path for SFTP, FTP, desktop and web login.
- [x] **Forced password change on first login** — the default `admin/admin123` (and any user flagged by an admin) must choose a new password before reaching the dashboard (desktop and web).
- [x] **HTTPS for the web GUI** — self-signed certificate generated on first use, or bring your own; HTTP→HTTPS option.
- [x] **FTPS (explicit TLS) for FTP listeners** — per-listener toggle, reuses the server certificate.
- [x] **Accurate docs** — replace the fictional API page with the real REST API; correct platform claims.

## Phase 2 — Headline features

- [x] **Browser file portal** — end users sign in at `/files` and browse, upload (drag & drop), download, create folders, rename and delete, honouring the same virtual-path permissions as SFTP/FTP.
- [x] **Share links** — expiring, optionally password-protected download links and upload-only "drop box" links, with download limits, revocation and a QR code.
- [ ] **Event rules & webhooks** — on upload / download / delete / login: POST a JSON webhook (Slack/Teams-compatible), optionally filtered by user and path.
- [ ] **Live transfers view** — per-session bytes and throughput on the dashboard.

## Phase 3 — Security that sells

- [ ] **Brute-force protection** — automatic temporary IP bans after repeated failed logins across all protocols; ban list in the GUI.
- [ ] **Per-user IP allow-list** (CIDR).
- [ ] **Two-factor authentication (TOTP)** for GUI / portal logins.
- [ ] **OpenSSH public keys** — paste `ssh-ed25519 …` / `ssh-rsa …` lines, multiple keys per user.
- [ ] **Audit export** — syslog forwarding; SHA-256 checksum recorded for every upload.

## Phase 4 — Storage & administration

- [ ] **Quotas** — per-user storage quota enforced on upload.
- [ ] **Bandwidth limits** — per-user upload/download rate limits.
- [ ] **Recycle bin** — deleted files are moved to a restorable trash with retention.
- [ ] **REST API tokens** — personal access tokens for automation.
- [ ] **Config backup / restore** from the GUI.
- [ ] **Docker image** for headless deployments.

## Phase 5 — Polish & reach

- [ ] First-run setup wizard.
- [ ] Auto-update from GitHub Releases.
- [ ] Dark mode.
- [ ] macOS build; winget / Homebrew / Flatpak listings.
- [ ] Cloud storage virtual paths (S3, Azure Blob).
- [ ] LDAP / Active Directory users.
