# SLightSFTP

Multi-user FTP/SFTP server with GUI management interface.

## Features

- Multiple SFTP, FTP and FTPS (explicit TLS) listeners
- Desktop GUI (Electron) and a browser-based admin GUI, optionally over HTTPS
- Multi-user support with password and public key authentication
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
- SQLite database for configuration storage; system tray support

See [ROADMAP.md](ROADMAP.md) for what's coming next.

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
`FTP_PASV_URL` to the server's public address. See `docker-compose.yml`.

## Installation

```bash
npm install
```

## Usage

```bash
# Start the application
npm start

# Run test client
npm test
```

## Default Credentials

- Username: `admin`
- Password: `admin123` — you must choose a new password the first time you sign in

## Configuration

All configurations are stored in SQLite database (`config.db`).

### User Configuration

- Username
- Password (optional)
- Public key (optional)
- Subscribed listeners
- GUI access
- Virtual path mappings
- Permissions

### Server Configuration

- Protocol (FTP/SFTP)
- Binding IP
- Port
- Enable/Disable

## Development

```bash
npm run dev
```
