# Quick Start Guide - Comprehensive Testing

## ✅ What's Ready

1. **10 Test Users Created** with different permission levels:
   - `fullaccess` - All permissions
   - `readonly` - Only LIST permission
   - `uploader` - CREATE + LIST
   - `editor` - EDIT + APPEND + LIST
   - `deleter` - DELETE + LIST
   - `dirmanager` - CREATE_DIR + LIST
   - `renamer` - RENAME + LIST
   - `creator` - CREATE + CREATE_DIR + LIST
   - `modifier` - CREATE + EDIT + APPEND + LIST
   - `poweruser` - All except DELETE

2. **Enhanced Test Client** that runs 10 simultaneous clients
   - Tests SFTP and FTP
   - Validates permissions for each user
   - Shows detailed pass/fail/skip results

## 🚀 How to Run Comprehensive Tests

### Option 1: Start Server First (Recommended)
```bash
# Terminal 1: Start the server
npm start

# Terminal 2: Run tests (after server starts)
npm run test:client
```

### Option 2: Use Server-Only Mode
```bash
# Terminal 1: Start server without GUI
npm run tools:build && node dist-tools/tools/server-only.js

# Terminal 2: Run tests
npm run test:client
```

### Option 3: All-in-One (if users not set up yet)
```bash
# Terminal 1: Start server
npm start

# Terminal 2: Setup users and run tests
npm run test:comprehensive
```

## 📊 Expected Test Results

When the server is running, you should see:

```
========================================
Running 10 concurrent clients
Protocol: SFTP
Host: localhost:2222
========================================

[fullaccess] Starting tests (Full permissions)...
[readonly] Starting tests (Read-only)...
...

[fullaccess] ✓ Connect to SFTP
[fullaccess] ✓ List root directory
[fullaccess] ✓ Create directory
[fullaccess] ✓ Upload file
[fullaccess] ✓ Download file
[fullaccess] ✓ Edit file
[fullaccess] ✓ Append to file
[fullaccess] ✓ Rename file
[fullaccess] ✓ Delete renamed file
[fullaccess] ✓ Delete directory
[fullaccess] ✓ Completed - Passed: 10, Failed: 0, Skipped: 0

[readonly] ✓ Connect to SFTP
[readonly] ✓ List root directory
[readonly] ✓ Create directory (should fail) - Failed as expected
[readonly] ✓ Upload file (should fail) - Failed as expected
[readonly] ⊘ Delete directory - Skipped: No DELETE or CREATE_DIR permission
[readonly] ✓ Completed - Passed: 4, Failed: 0, Skipped: 1

...

========================================
Test Summary for SFTP
========================================
✓ fullaccess      - Pass: 10, Fail: 0, Skip: 0 (1234ms)
✓ readonly        - Pass: 4, Fail: 0, Skip: 1 (567ms)
✓ uploader        - Pass: 5, Fail: 0, Skip: 5 (789ms)
✓ editor          - Pass: 5, Fail: 0, Skip: 5 (678ms)
✓ deleter         - Pass: 5, Fail: 0, Skip: 5 (654ms)
✓ dirmanager      - Pass: 4, Fail: 0, Skip: 6 (543ms)
✓ renamer         - Pass: 5, Fail: 0, Skip: 5 (632ms)
✓ creator         - Pass: 6, Fail: 0, Skip: 4 (823ms)
✓ modifier        - Pass: 7, Fail: 0, Skip: 3 (912ms)
✓ poweruser       - Pass: 9, Fail: 0, Skip: 1 (1089ms)

Total Tests: 60
Passed: 60 | Failed: 0 | Skipped: 35
Total Time: 3200ms
========================================
```

## 🔧 Troubleshooting

### Connection Refused
**Problem:** Tests show "Remote host refused connection"  
**Solution:** Start the server first with `npm start` or `npm run tools:build && node dist-tools/tools/server-only.js`

### Users Don't Exist
**Problem:** Authentication failures  
**Solution:** Run `npm run setup:testusers` to create test users

### Need to Reset Users
```bash
# Delete the database and restart
rm config.db
npm start  # This creates new database with default admin
npm run setup:testusers  # Add test users
npm run test:client  # Run tests
```

## 📝 Test User Credentials

All test users use password: `test123`

| Username | Permissions |
|----------|------------|
| fullaccess | All (7/7) |
| readonly | LIST only (1/7) |
| uploader | CREATE, LIST (2/7) |
| editor | EDIT, APPEND, LIST (3/7) |
| deleter | DELETE, LIST (2/7) |
| dirmanager | CREATE_DIR, LIST (2/7) |
| renamer | RENAME, LIST (2/7) |
| creator | CREATE, CREATE_DIR, LIST (3/7) |
| modifier | CREATE, EDIT, APPEND, LIST (4/7) |
| poweruser | All except DELETE (6/7) |

## 🎯 What Gets Tested

Each user tests:
1. Connection
2. List directory (if has LIST)
3. Create directory (if has CREATE_DIR)
4. Upload file (if has CREATE)
5. Download file (if has LIST)
6. Edit file (if has EDIT)
7. Append to file (if has APPEND)
8. Rename file (if has RENAME)
9. Delete file (if has DELETE)
10. Delete directory (if has DELETE + CREATE_DIR)

Tests are:
- ✓ **Passed** - Operation succeeded as expected
- ✗ **Failed** - Operation failed unexpectedly
- ⊘ **Skipped** - User lacks required permission

## 📖 More Information

See [TEST_SUITE.md](TEST_SUITE.md) for detailed documentation.
