# Test Suite Documentation

This document describes the unit test coverage for the SLightSFTP application.

## Test layers (v1.2.0)

| Layer | Command | What it proves |
|-------|---------|----------------|
| Unit / integration (Jest) | `npm test` | Database, path mapping, permissions, FTP/SFTP servers, web API |
| Full-stack E2E (Jest) | `npx jest e2e-fullstack` | Admin provisions through the REST API; real SFTP/FTP clients then upload, download, rename, get disconnected, hit permission and traversal limits |
| Electron main process (Jest) | `npx jest main-process` | Every IPC handler in `main.ts` against a real DB and real servers (Electron itself faked) |
| GUI in jsdom (Jest) | `npx jest gui-` | The real `index.html` + `renderer.js` and `login.html`: every panel, modal and form, the exact IPC calls produced, HTML escaping |
| Contract tests (Jest) | `npx jest web-shim-contract preload` | GUI channels ⇄ main-process handlers ⇄ preload whitelist ⇄ web-mode IPC shim |
| Browser GUI (Playwright) | `npm run test:e2e:web` | Chromium drives the web GUI served by `dist/web-only.js`; results verified with real SFTP clients |
| Desktop GUI (Playwright) | `npm run test:e2e:electron` | The real Electron app: login window, dashboard, web server control, logout |

Run everything with `npm run test:all`. The Playwright suites need Chromium once
(`npx playwright install chromium`) and, on a headless Linux machine, a virtual display:
`xvfb-run -a npm run test:e2e`.

Integration tests bind random free ports on 127.0.0.1 (see `src/__tests__/helpers/test-env.ts`),
so they can run alongside a locally running SLightSFTP.

## Overview

The test suite is built using **Jest** with **TypeScript** support via `ts-jest`. Tests verify type definitions, data structures, and business logic.

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests in watch mode
```bash
npm run test:watch
```

### Generate coverage report
```bash
npm run test:coverage
```

### Run integration test client
```bash
npm run test:client
```

## Test Structure

### Type Definitions Tests (`types.test.ts`)

Tests the TypeScript interfaces and type definitions to ensure data structures are correctly defined.

#### User Type Tests
- ✅ Validates all required user properties
- ✅ Tests optional public key field
- ✅ Verifies password and GUI flags

#### Listener Type Tests
- ✅ Validates SFTP listener configuration
- ✅ Validates FTP listener configuration  
- ✅ Ensures only FTP or SFTP protocols are allowed

#### Permission Type Tests
- ✅ Validates all permission flags (create, edit, append, delete, list, createDir, rename)
- ✅ Tests permission combinations
- ✅ Verifies restrictive permissions

#### VirtualPath Type Tests
- ✅ Validates virtual to local path mapping structure
- ✅ Tests path properties

#### ServerActivity Type Tests
- ✅ Validates activity logging structure
- ✅ Tests successful operations
- ✅ Tests failed operations

#### UserListener Type Tests
- ✅ Validates user-listener association structure

## Test Coverage

Current test coverage focuses on:
- ✅ **Type Safety**: All TypeScript interfaces are tested
- ✅ **Data Structures**: User, Listener, Permission, VirtualPath, Activity models
- ⚠️ **Integration Tests**: Manual test client available via `npm run test:client`

### Excluded from Unit Tests
- **Electron Main Process** (`main.ts`): GUI lifecycle requires E2E testing
- **Renderer Process** (`renderer.js`): Browser-based GUI components
- **Integration Tests**: Database, SFTP, FTP servers tested via test client

## Future Enhancements

### Recommended Additional Tests
1. **Database Integration Tests**
   - Test database CRUD operations with in-memory SQLite
   - Verify transaction handling
   - Test foreign key constraints

2. **Server Unit Tests**
   - Mock authentication flows
   - Test permission checking logic
   - Verify activity logging

3. **Server Manager Tests**
   - Test listener lifecycle (start/stop/restart)
   - Verify event forwarding
   - Test concurrent operations

4. **E2E Tests**
   - Automated GUI testing with Spectron/Playwright
   - Full workflow tests (user creation → file upload → activity log)
   - Multi-client stress testing

## Test Client

The integration test client (`test-client.ts`) provides comprehensive protocol testing:

### Features
- ✅ Multi-client concurrent testing (5 clients per protocol)
- ✅ SFTP operations: list, upload, download, rename, delete
- ✅ FTP operations: list, upload, download, rename, delete
- ✅ Authentication testing
- ✅ Permission verification
- ✅ Activity logging validation

### Usage
```bash
# Start the GUI server first
npm start

# In another terminal, run the test client
npm run test:client
```

### Test Scenarios
1. **Authentication**: Valid and invalid credentials
2. **File Upload**: Multiple concurrent uploads
3. **File Download**: Verify uploaded content
4. **File Listing**: Directory enumeration
5. **File Rename**: Move/rename operations
6. **File Delete**: Cleanup operations
7. **Concurrent Access**: Race condition testing

## Continuous Integration

To integrate with CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run Tests
  run: npm test

- name: Generate Coverage
  run: npm run test:coverage

- name: Upload Coverage
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/lcov.info
```

## Dependencies

### Testing Framework
- `jest@^29.7.0` - Test runner
- `ts-jest@^29.1.1` - TypeScript support
- `@types/jest@^29.5.11` - Type definitions

### Production Dependencies (tested indirectly)
- `sql.js@^1.10.3` - Database engine
- `ssh2@^1.15.0` - SFTP protocol
- `ftp-srv@^4.6.3` - FTP protocol
- `electron@^28.1.0` - GUI framework

## Contributing

When adding new features, please:
1. Add corresponding unit tests in `src/__tests__/`
2. Maintain >80% code coverage for business logic
3. Update this documentation
4. Ensure all tests pass before submitting PRs

## Troubleshooting

### Common Issues

**Issue**: Tests fail with "Cannot find module"
```bash
Solution: npm install
```

**Issue**: TypeScript compilation errors
```bash
Solution: npm run build
```

**Issue**: Test client connection refused
```bash
Solution: Ensure servers are running (npm start)
```

**Issue**: Port already in use
```bash
Solution: Stop existing processes on ports 2222 and 2121
```

## Contact

For questions about the test suite, please refer to the project documentation or create an issue in the repository.
