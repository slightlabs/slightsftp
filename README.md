# SLightSFTP

Multi-user FTP/SFTP server with GUI management interface.

## Features

- Multiple SFTP, FTP and FTPS (explicit TLS) listeners
- Desktop GUI (Electron) and a browser-based admin GUI, optionally over HTTPS
- Multi-user support with password and public key authentication
- Virtual path mapping with granular per-user, per-path permissions
- Users can never leave their virtual paths (`..` is confined)
- Salted scrypt password hashing; forced password change on first login
- Stable SFTP host key with a fingerprint you can share with users
- Live sessions, activity log and a REST API ([docs](https://slightlabs.github.io/slightsftp/api.html))
- SQLite database for configuration storage; system tray support

See [ROADMAP.md](ROADMAP.md) for what's coming next.

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
