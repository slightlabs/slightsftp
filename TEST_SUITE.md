# Comprehensive Test Suite

## Overview
This test suite includes 10 different test users with varying permission levels to comprehensively test all FTP/SFTP server functionality.

## Test Users

| Username    | Password | Description | Permissions |
|------------|----------|-------------|-------------|
| fullaccess | test123  | Full permissions - can do everything | All |
| readonly   | test123  | Read-only user - can only list | LIST |
| uploader   | test123  | Upload only - can create and list | CREATE, LIST |
| editor     | test123  | Editor - can edit and append files | EDIT, APPEND, LIST |
| deleter    | test123  | Deleter - can delete files | DELETE, LIST |
| dirmanager | test123  | Directory manager - can create dirs | CREATE_DIR, LIST |
| renamer    | test123  | Renamer - can rename files | RENAME, LIST |
| creator    | test123  | Creator - can create files and dirs | CREATE, CREATE_DIR, LIST |
| modifier   | test123  | Modifier - can create, edit, append | CREATE, EDIT, APPEND, LIST |
| poweruser  | test123  | Power user - all except delete | All except DELETE |

## Setup Instructions

### 1. Start the Server
```bash
npm start
```
This will start the GUI application and both SFTP (port 22) and FTP (port 21) servers.

### 2. Setup Test Users
```bash
npm run setup:testusers
```
This will:
- Create all 10 test users in the database
- Configure their permissions
- Subscribe them to all active listeners
- Create virtual path mappings

### 3. Run Comprehensive Tests
```bash
npm run test:client
```
This will:
- Run 10 concurrent SFTP clients (one per user)
- Test all operations based on each user's permissions
- Run 10 concurrent FTP clients (one per user)
- Display detailed results for each user

### Quick All-in-One Test
```bash
npm run test:comprehensive
```
This combines steps 2 and 3 (setup + test).

## Test Coverage

Each client tests the following operations (where permissions allow):

### SFTP Tests
1. **Connection** - Connect to SFTP server
2. **List Directory** - List root directory contents
3. **Create Directory** - Create user-specific test directory
4. **Upload File** - Upload a test file (requires CREATE)
5. **Download File** - Download and verify file content (requires LIST)
6. **Edit File** - Overwrite file content (requires EDIT)
7. **Append to File** - Append content to file (requires APPEND)
8. **Rename File** - Rename file (requires RENAME)
9. **Delete File** - Delete file (requires DELETE)
10. **Delete Directory** - Remove test directory (requires DELETE + CREATE_DIR)

### FTP Tests
Same operations as SFTP, adapted for FTP protocol.

## Expected Results

### Full Access User
- ✓ All tests should pass
- Expected: 10+ passed tests

### Read-Only User
- ✓ Connection, List Directory
- ✗ All write operations should fail as expected
- Expected: 2 passed, 8 failed (as expected)

### Specialized Users
Each user will:
- ✓ Pass tests for operations they have permission for
- ✗ Fail or skip tests for operations they lack permission for
- Demonstrate proper permission enforcement

## Test Output

The test client provides detailed output:
```
========================================
Running 10 concurrent clients
Protocol: SFTP
Host: localhost:2222
========================================

[fullaccess] Starting tests (Full permissions)...
[readonly] Starting tests (Read-only)...
[uploader] Starting tests (Upload only)...
...

[fullaccess] ✓ Connect to SFTP
[fullaccess] ✓ List root directory
[fullaccess] ✓ Create directory
...

========================================
Test Summary for SFTP
========================================
✓ fullaccess     - Pass: 10, Fail: 0, Skip: 0 (1250ms)
✓ readonly       - Pass: 2, Fail: 0, Skip: 8 (450ms)
✓ uploader       - Pass: 4, Fail: 0, Skip: 6 (780ms)
...

Total Tests: 80
Passed: 65 | Failed: 0 | Skipped: 15
Total Time: 3200ms
========================================
```

## Manual Testing

You can also test individual users manually:

### SFTP
```bash
sftp -oPort=2222 fullaccess@localhost
# Password: test123
sftp> ls
sftp> mkdir testdir
sftp> put file.txt
sftp> get file.txt
```

### FTP
```bash
ftp localhost 2121
# Username: readonly
# Password: test123
ftp> ls
ftp> put file.txt  # This should fail for readonly user
```

## Troubleshooting

### Users already exist
Run `npm run setup:testusers` again - it will update existing users.

### Server not running
Make sure you started the server with `npm start` before running tests.

### Port conflicts
Check that ports 2222 (SFTP) and 2121 (FTP) are not in use by other applications.

### Permission errors
The test suite expects certain operations to fail for restricted users - this is correct behavior.

## Development

To add more test scenarios:
1. Edit [tools/test-client.ts](tools/test-client.ts)
2. Add new test cases in `testSFTP()` or `testFTP()` methods
3. Rebuild: `npm run build`
4. Run: `npm run test:client`

To add more test users:
1. Edit [tools/setup-test-users.ts](tools/setup-test-users.ts)
2. Add user configuration to `testUsers` array
3. Run: `npm run setup:testusers`
