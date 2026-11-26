# SLightSFTP

Multi-user FTP/SFTP server with GUI management interface.

## Features

- Multiple SFTP, FTP and FTPS (explicit TLS) listeners
- Desktop GUI (Electron) and a browser-based admin GUI, optionally over HTTPS
- Multi-user support with password and public key authentication
- Administrator and read-only roles for the GUI
- Virtual path mapping with granular per-user, per-path permissions
- Cloud storage folders: point a virtual path at an Amazon S3 bucket (or MinIO, Wasabi,
  Cloudflare R2, Backblaze B2, ...) or an Azure Blob container (*Cloud Storage* panel)
- Browser file portal (`/files`) and share links, LDAP / Active Directory sign-in,
  two-factor sign-in, brute-force protection, quotas, speed limits, recycle bin,
  webhooks, syslog export, API tokens and configuration backup
- Users can never leave their virtual paths (`..` is confined)
- Salted scrypt password hashing; forced password change on first login
- Stable SFTP host key with a fingerprint you can share with users
- Live sessions, activity log and a REST API ([docs](https://slightlabs.github.io/slightsftp/api.html))
- Prometheus metrics (`/metrics`) and health checks (`/healthz`, `/readyz`) for monitoring
- SQLite database for configuration storage; system tray support

See [ROADMAP.md](ROADMAP.md) for what's coming next, [CONTRIBUTING.md](CONTRIBUTING.md) to build and test it, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Docker

```bash
docker run -d --name slightsftp \
  -p 3000:3000 -p 2222:2222 \
  -v slightsftp-data:/data -v /srv/files:/files \
  -e WEB_HTTPS=true \
  ghcr.io/slightlabs/slightsftp:latest
```

Open https://localhost:3000, sign in as `admin` / `admin123` (you will be asked for a new
password), create an SFTP listener on port 2222 and map users' virtual paths to folders
under `/files`. Configuration, keys and the recycle bin are kept in the `/data` volume.
For FTP, also publish port 2121 and the passive range `30000-30009`, and set
`FTP_PASV_URL` to the server's public address. Behind a reverse proxy (nginx, Caddy,
Traefik), set `TRUST_PROXY` to the proxy's address or range (e.g. `TRUST_PROXY=172.16.0.0/12`)
so brute-force protection sees real client addresses. See `docker-compose.yml`.

Scheduled backups (*Security → Backup & Restore*) go to `/data/backups` by default; mount
another volume (e.g. `-v /mnt/backup/slightsftp:/backups`) and set the folder to `/backups`
so they do not live on the same disk as the data.

Logging: `LOG_LEVEL` (`info`; `http` adds one line per web request, `debug` per file
operation), `LOG_FORMAT=json` for one JSON object per line (log collectors), and
`LOG_FILES=false` to log to stdout only. Every web response carries an `X-Request-Id`
that also appears in the log lines written while handling it.

For a production setup (reverse proxy, upgrades and rollback, backups, monitoring,
hardening) see [Running in Production](https://slightlabs.github.io/slightsftp/operations.html).

Run **one container per data volume**: the configuration is a SQLite database, so two
instances must not share `/data`. Sign-ins to the web GUI and the file portal are stored
in it, so restarting or updating the container does not sign anyone out.

## Installation

Download the installer for Windows (.msi), macOS (.dmg) or Linux (.AppImage, .deb) from
[Releases](https://github.com/slightlabs/slightsftp/releases), or run the Docker image
above. To build from source, see [CONTRIBUTING.md](CONTRIBUTING.md):

```bash
npm ci
npm start            # desktop app
npm run start:web    # headless server with the web admin GUI on :3000
```

## Default Credentials

- Username: `admin`
- Password: `admin123` — you must choose a new password the first time you sign in

## Configuration

Everything is configured in the GUI and stored in a SQLite database, `config.db`, with
its secrets encrypted by the master key in `secret.key` next to it — back up both, or use
the built-in (scheduled, passphrase-encrypted) backups. See the
[configuration guide](https://slightlabs.github.io/slightsftp/configuration.html).
