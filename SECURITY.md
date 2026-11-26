# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately via
[GitHub's private vulnerability reporting](https://github.com/slightlabs/slightsftp/security/advisories/new)
(*Security → Report a vulnerability*).

Include the version, how the server is deployed (desktop app, Docker, headless), and the
steps to reproduce. You can expect an acknowledgement within 3 working days and a fix or
mitigation plan within 30 days for confirmed issues; we will credit you in the release
notes unless you prefer otherwise.

## Supported versions

Security fixes go into the latest release. Please upgrade before reporting.

## Scope

In scope: the SFTP / FTP / FTPS listeners, the web admin GUI and REST API, the file portal
and share links, the desktop app, the Docker image, and the release artifacts.

## Hardening guidance

- Change the default `admin` password (enforced on first sign-in) and enable two-factor sign-in.
- Expose the web GUI over HTTPS only, ideally behind a reverse proxy (set `TRUST_PROXY`).
- Keep `secret.key` with `config.db` and encrypt configuration backups with a passphrase.
- Leave *SSH algorithms* on *Modern* unless a client needs SHA-1.
- Verify downloads: `SHA256SUMS`, `gh attestation verify`, and `cosign verify` for the image
  (see [docs/RELEASE.md](docs/RELEASE.md)).
