# SLightSFTP - Installation and Setup Guide

## Prerequisites

- Node.js 18.x or higher
- npm 9.x or higher
- Windows operating system

## Installation Steps

### 1. Install Dependencies

```bash
cd "c:\Users\<YourUsername>\src\SLightSFTP"
npm install
```

### 2. Build the Application

```bash
npm run build
```

### 3. Create FTP Root Directory

The application will automatically create the default FTP root directory at:
`<project-root>/ftp-root`

However, you can create it manually if needed:

```bash
mkdir ftp-root
```

## Running the Application

### Start the GUI Application

```bash
npm start
```

This will:
- Initialize the SQLite database
- Create the default admin user (username: `admin`, password: `admin123`)
- Create two default listeners:
  - SFTP on port 22
  - FTP on port 21
- Start the Electron GUI

### The GUI will:
- Start on the dashboard showing server overview
- Allow you to manage listeners (start/stop/edit/delete)
- Allow you to manage users
- Show real-time activity logs
- Minimize to system tray when closed

## Running Tests

To test the server with multiple concurrent clients:

```bash
npm test
```

This will:
- Connect 5 concurrent SFTP clients
- Connect 5 concurrent FTP clients
- Test all operations: create, read, write, append, delete, rename, list

## Default Configuration

### Default Admin User
- **Username**: admin
- **Password**: admin123
- **GUI Access**: Enabled
- **FTP/SFTP Access**: Enabled
- **Permissions**: Full access

### Default Listeners

#### SFTP Listener
- **Name**: Default SFTP
- **Protocol**: SFTP
- **IP**: 0.0.0.0 (all interfaces)
- **Port**: 2222
- **Status**: Enabled

#### FTP Listener
- **Name**: Default FTP
- **Protocol**: FTP
- **IP**: 0.0.0.0 (all interfaces)
- **Port**: 2121
- **Status**: Enabled

### Default Virtual Path
- **Virtual**: /
- **Local**: `<project-root>/ftp-root`

## Using the GUI

### Dashboard
- View server statistics
- See active listeners
- Monitor recent activity

### Listeners Tab
- Add new listeners (FTP or SFTP)
- Start/Stop listeners
- Edit listener configurations
- Delete listeners

### Users Tab
- Add new users
- Configure authentication (password and/or public key)
- Set GUI access permissions
- Edit user details
- Subscribe users to listeners
- Configure virtual paths
- Delete users

### Activity Log Tab
- View all server activities
- See login attempts
- Monitor file operations
- Track user actions

## Connecting to the Server

### Using SFTP Client (e.g., FileZilla, WinSCP)
- **Protocol**: SFTP
- **Host**: localhost (or your server IP)
- **Port**: 2222
- **Username**: admin
- **Password**: admin123

### Using FTP Client
- **Protocol**: FTP
- **Host**: localhost (or your server IP)
- **Port**: 2121
- **Username**: admin
- **Password**: admin123

## Troubleshooting

### Port Already in Use
If ports 21 or 22 are already in use:
1. Open the GUI
2. Go to Listeners tab
3. Edit the listener
4. Change to a different port

### Cannot Connect
1. Check if the listener is running (green indicator)
2. Verify firewall settings
3. Check user is subscribed to the listener
4. Verify credentials

### Database Issues
If you encounter database issues:
1. Stop the application
2. Delete `config.db`
3. Restart the application (will recreate with defaults)

## Advanced Configuration

### Adding Virtual Paths
1. Go to Users tab
2. Click Edit on a user
3. Scroll to Virtual Paths section
4. Click "Add Virtual Path"
5. Enter virtual path (e.g., `/documents`)
6. Enter local path (e.g., `C:\Users\YourName\Documents`)

### Setting Permissions
Permissions are automatically set to full access when subscribing a user to a listener. To customize:
1. Modify the database directly, or
2. Edit the source code in `main.ts` where permissions are set

### Using Public Key Authentication (SFTP only)
1. Generate SSH key pair
2. Go to Users tab
3. Edit user
4. Paste public key in base64 format
5. Optionally disable password authentication

## System Tray

When you close the main window, the application minimizes to the system tray:
- Right-click the tray icon to show menu
- Click "Show" to restore window
- Click "Quit" to exit application

## File Structure

```
SLightSFTP/
├── src/
│   ├── database.ts          # Database management
│   ├── types.ts             # TypeScript interfaces
│   ├── sftp-server.ts       # SFTP server implementation
│   ├── ftp-server.ts        # FTP server implementation
│   ├── server-manager.ts    # Server orchestration
│   ├── main.ts              # Electron main process
│   ├── renderer.js          # Electron renderer process
│   ├── index.html           # GUI HTML
│   └── test-client.ts       # Test client
├── dist/                    # Compiled JavaScript
├── ftp-root/               # Default FTP root directory
├── config.db               # SQLite database
├── package.json
├── tsconfig.json
└── README.md
```

## Development

### Run in Development Mode

```bash
npm run dev
```

### Modify the Code

After making changes to TypeScript files:

```bash
npm run build
```

Then restart the application.

## Security Notes

⚠️ **Important Security Considerations**:

1. Change the default admin password immediately
2. Use strong passwords for all users
3. Consider using public key authentication for SFTP
4. Be careful with virtual path mappings - don't expose sensitive directories
5. Run the server behind a firewall in production
6. Monitor the activity log regularly
7. Use SFTP instead of FTP when possible (FTP is unencrypted)

## Support

For issues or questions:
1. Check the Activity Log in the GUI
2. Check console output
3. Review the README.md
4. Check the source code comments
