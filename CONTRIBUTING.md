# Contributing to SLightSFTP

## Setup

Requirements: Node.js 22.16 or later (the configuration database uses the built-in
`node:sqlite`) and npm 10.

```bash
npm ci
npm run build        # TypeScript → dist/, plus the HTML / renderer files
npm start            # desktop app (Electron)
npm run start:web    # headless server with the web admin GUI on :3000
```

On a fresh install, sign in as `admin` / `admin123`; you are asked for a new password.

## Tests

```bash
npm test                 # Jest: unit, integration (real SFTP/FTP/HTTP servers) and GUI DOM tests
npm run test:e2e         # Playwright: the web GUI in Chromium and the Electron app
npx tsc --noEmit         # type-check
```

Every change ships with tests. Integration tests start real listeners on free ports
(`getFreePort()` in `src/__tests__/helpers/test-env.ts`) and use temporary folders, so the
suite runs in parallel and leaves nothing behind. The S3 and Azure backends are tested
against in-process fakes, and in CI also against real S3 (`adobe/s3mock`) and Azurite.

## Layout

| Path | What |
| --- | --- |
| `src/main.ts`, `src/preload.ts`, `src/renderer.js`, `src/*.html` | Electron app and GUI |
| `src/web-only.ts`, `src/web-server.ts` | Headless entry point and the web GUI / REST API |
| `src/sftp-server.ts`, `src/ftp-server.ts`, `src/server-manager.ts` | Protocol listeners |
| `src/database.ts`, `src/sqlite.ts` | Configuration database and its schema migrations |
| `src/__tests__/`, `e2e/` | Jest and Playwright tests |
| `tools/` | Developer scripts (built to `dist-tools/`, never shipped) |
| `vendor/ip` | Minimal replacement for an unmaintained transitive dependency |
| `docs/` | Website (GitHub Pages) and release guide |

## Database changes

Add a migration to `DatabaseManager.migrations` and bump `SCHEMA_VERSION` — never edit a
released migration. Migrations run in a transaction; a copy of the old database is saved
before an upgrade, and older versions refuse to open a newer database.

## Commits and pull requests

- One logical change per commit, with a message that says why.
- Add a line to `CHANGELOG.md` under *Unreleased* for anything users or operators notice.
- CI must pass: type-check, Jest on Node 22 and 24, Playwright, the Docker smoke test and
  `npm audit --omit=dev --audit-level=high`.

## Releases

See [docs/RELEASE.md](docs/RELEASE.md).
