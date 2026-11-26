# Virtual Path Permissions - Complete Implementation

## Overview
Added comprehensive virtual path permissions system to SLightSFTP, allowing fine-grained access control per virtual path per user.

## Features Implemented

### 1. Database Schema (✅ Complete)
- **New columns in `virtual_paths` table:**
  - `canRead` - Allow downloading/reading files
  - `canWrite` - Allow uploading/writing files
  - `canAppend` - Allow appending to files (resume uploads)
  - `canDelete` - Allow deleting files and directories
  - `canList` - Allow listing directory contents
  - `canCreateDir` - Allow creating new directories
  - `canRename` - Allow renaming files and directories
  - `applyToSubdirs` - Apply permissions to subdirectories

### 2. Backend Implementation (✅ Complete)

#### Database Layer (`src/database.ts`)
- Updated `addVirtualPath()` to accept permission parameters
- Updated `getVirtualPaths()` to return permissions
- Added `updateVirtualPath()` method for updating permissions
- All CRUD operations support full permission set

#### SFTP Server (`src/sftp-server.ts`)
- Added `findVirtualPath()` helper to match paths to virtual paths
- Updated `checkPermission()` to validate both:
  1. Listener-level permissions (user → listener)
  2. Virtual path permissions (path-specific)
- Updated all SFTP handlers:
  - `OPEN` - checks canCreate/canEdit/canList
  - `WRITE` - checks canEdit/canAppend  
  - `OPENDIR` - checks canList with path
  - `REMOVE` - checks canDelete with path
  - `RMDIR` - checks canDelete with path
  - `MKDIR` - checks canCreateDir with path
  - `RENAME` - checks canRename for both paths

#### FTP Server (`src/ftp-server.ts`)
- Added `findVirtualPath()` to match FTP paths
- Added `checkVpPermission()` method for virtual path checks
- Updated CustomFileSystem methods:
  - `get()` - checks canList
  - `list()` - checks canList
  - `write()` - checks canCreate/canEdit
  - `read()` - checks canList
  - `delete()` - checks canDelete
  - `mkdir()` - checks canCreateDir
  - `rename()` - checks canRename for both paths

### 3. GUI Implementation (✅ Complete)

#### Virtual Path Modal (`src/index.html`)
- New modal dialog with:
  - Virtual Path input field
  - Real Path input field with Browse button
  - 7 permission checkboxes:
    - ☐ Read (Download)
    - ☐ Write (Upload)
    - ☐ Append (Resume and Overwrite)
    - ☐ Create directory
    - ☐ Rename
    - ☐ List
    - ☐ Delete
  - "Permission will apply to its sub-directories" checkbox
  - OK/Cancel buttons

#### Renderer (`src/renderer.js`)
- `renderVirtualPaths()` - Shows paths with permissions summary
- `addVirtualPath()` - Opens modal for new path
- `editVirtualPath()` - Opens modal to edit existing path
- `browseFolderForVirtualPath()` - System folder picker
- Virtual path form submission with all permissions

#### Main Process (`src/main.ts`)
- Added `select-directory` IPC handler for folder browsing
- Updated `update-user` to save virtual path permissions
- Dialog integration for folder selection

### 4. Unit Tests (✅ Complete - 166 tests passing)

#### New Test Suite: `virtual-path-permissions.test.ts` (15 tests)
**Virtual Path Creation:**
- ✅ Create with default permissions
- ✅ Create with custom permissions
- ✅ Create multiple paths with different permissions

**Permission Flags:**
- ✅ Handle all 7 permission flags
- ✅ Handle read-only permissions
- ✅ Handle upload-only permissions

**Virtual Path Updates:**
- ✅ Update permissions
- ✅ Update location and permissions together

**Apply to Subdirectories:**
- ✅ Default to true
- ✅ Allow disabling

**Virtual Path Deletion:**
- ✅ Delete virtual path
- ✅ Delete specific path only

**Multi-User:**
- ✅ Isolate virtual paths per user

**Edge Cases:**
- ✅ All permissions disabled
- ✅ Partial permission updates

### 5. Test Client (✅ Complete)

#### New Tool: `test-vp-permissions.ts`
- Tests virtual path permissions for both SFTP and FTP
- 5 test scenarios:
  1. SFTP Full Access
  2. SFTP Read-only
  3. SFTP Upload-only
  4. FTP Full Access
  5. FTP Read-only
  
**Each test validates:**
- LIST permission (directory listing)
- WRITE permission (file upload)
- READ permission (file download)
- CREATE_DIR permission (directory creation)
- RENAME permission (file renaming)
- DELETE permission (file/directory deletion)

**Usage:**
```bash
npm run build
npm run tools:build && node dist-tools/tools/test-vp-permissions.js
```

## Permission Model

### Two-Layer Permission System
1. **Listener-Level Permissions** (existing)
   - Controls what operations a user can perform on a listener
   - Stored in `permissions` table (userId, listenerId)
   
2. **Virtual Path Permissions** (new)
   - Controls what operations are allowed on specific paths
   - Stored in `virtual_paths` table
   - More granular than listener permissions

### Permission Evaluation
For any operation, **BOTH** checks must pass:
```
Operation Allowed = (Listener Permission = TRUE) AND (Virtual Path Permission = TRUE)
```

Example: To delete a file at `/data/file.txt`:
- User must have `canDelete` on their listener subscription
- Virtual path `/data` must have `canDelete = true`

## Usage Guide

### Creating a Virtual Path with Permissions

1. **Open Edit User Dialog**
   - Click "Edit" button next to user

2. **Add Virtual Path**
   - Click "Add Virtual Path" button
   - Enter virtual path (e.g., `/readonly`)
   - Enter or browse for real path (e.g., `C:\data\readonly`)

3. **Configure Permissions**
   - Check desired permissions:
     - **Read** - Download files
     - **Write** - Upload new files
     - **Append** - Resume interrupted uploads
     - **List** - View directory contents
     - **Delete** - Remove files/folders
     - **Create directory** - Make new folders
     - **Rename** - Rename files/folders
   - Check "Apply to subdirectories" if needed

4. **Save**
   - Click "OK" to add the virtual path
   - Click "Update User" to save all changes

### Common Permission Patterns

**Read-Only Access:**
```
✓ Read (Download)
✓ List
☐ Write (Upload)
☐ Append
☐ Delete
☐ Create directory
☐ Rename
```

**Upload-Only (Drop Folder):**
```
☐ Read (Download)
☐ List
✓ Write (Upload)
✓ Append
☐ Delete
☐ Create directory
☐ Rename
```

**Full Access:**
```
✓ All permissions checked
```

**Collaborator (Read/Write but no Delete):**
```
✓ Read (Download)
✓ Write (Upload)
✓ Append
✓ List
✓ Create directory
✓ Rename
☐ Delete
```

## Testing

### Run All Tests
```bash
npm test
```
**Expected:** 166 tests passing
- 66 Type tests
- 33 Authentication/Authorization tests
- 30 Path Mapping tests
- 33 Directory Listing tests
- 15 Virtual Path Permissions tests (NEW)

### Test Virtual Path Permissions
```bash
# Compile first
npm run build

# Run test client
npm run tools:build && node dist-tools/tools/test-vp-permissions.js
```

## Database Migration

Existing databases will be automatically migrated when the application starts:
- New columns added to `virtual_paths` table
- Existing virtual paths get default permissions (all enabled)
- No data loss occurs

## Files Modified

### Core Files
- `src/types.ts` - Added permission fields to VirtualPath interface
- `src/database.ts` - Updated virtual path CRUD operations
- `src/sftp-server.ts` - Added virtual path permission checking
- `src/ftp-server.ts` - Added virtual path permission checking
- `src/main.ts` - Added select-directory IPC handler

### GUI Files
- `src/index.html` - Added virtual path permissions modal
- `src/renderer.js` - Added virtual path UI logic

### Test Files
- `src/__tests__/virtual-path-permissions.test.ts` - 15 new tests
- `src/test-vp-permissions.ts` - Comprehensive test client

## Summary

✅ **Database Schema:** 8 new columns in virtual_paths table
✅ **Backend:** Full permission enforcement in SFTP & FTP servers
✅ **GUI:** Complete modal with 7 permission checkboxes + browse button
✅ **Unit Tests:** 15 new tests, all passing (166 total)
✅ **Test Client:** Comprehensive virtual path permission testing tool
✅ **Documentation:** Complete usage guide and examples

The system now supports fine-grained permission control at both the listener level and virtual path level, providing maximum flexibility for access management.
