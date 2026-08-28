# Building SLightSFTP

## Prerequisites

1. **Node.js** v18 or higher
2. **npm** (comes with Node.js)

### Windows only
- **WiX Toolset** v3.11 or higher (optional — electron-builder downloads it automatically)

### Linux only
- **rpmbuild** (optional, for RPM packages): `sudo apt install rpm` / `sudo dnf install rpm-build`
- **fakeroot** (for deb packages): `sudo apt install fakeroot`
- No root required for AppImage builds

## Directory Structure

### Windows

```
C:\Program Files\SLightSFTP\
├── bin\                    # Application binaries
│   └── SLightSFTP.exe     # Main executable
├── config\                 # Configuration files
│   └── config.db          # Database file
├── data\                   # Data directory
│   └── ftp-root\          # Default FTP root directory
├── logs\                   # Log files
└── resources\              # Application resources
```

### Linux (installed via deb/rpm)

```
/opt/SLightSFTP/
├── slightsftp              # Main executable
├── resources/
│   ├── app/
│   ├── config/
│   │   └── config.db      # Database file
│   ├── logs/              # Log files
│   └── data/
│       └── ftp-root/      # Default FTP root directory
```

The AppImage is self-contained and runs from wherever you place it.

## Building

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Build TypeScript

```bash
npm run build
```

### Step 3a: Build for Windows (MSI)

```powershell
npm run dist:win
```

Output: `release/SLightSFTP-1.1.0-setup.msi`

### Step 3b: Build for Linux (AppImage + deb)

```bash
npm run dist:linux
```

Output:
- `release/SLightSFTP-1.1.0.AppImage` — universal, no install needed
- `release/SLightSFTP-1.1.0.deb` — Debian/Ubuntu package

### Running in Web Server Mode (any platform, no Electron needed)

```bash
npm run start:web
```

Opens the management GUI at `http://localhost:3000`. Use `WEB_PORT=8080 npm run start:web` to change the port.

## Installation Features

### Windows MSI installer includes

✅ **User-selectable installation directory**
  - Default: `C:\Program Files\SLightSFTP`
  - User can change during installation

✅ **Desktop shortcut creation**
  - Prompted during installation

✅ **Start Menu shortcuts**
  - Automatically created in Start Menu

✅ **Proper uninstallation support**
  - Can be uninstalled from Windows Settings

✅ **Per-machine installation**
  - Installed for all users
  - Requires administrator privileges

### Linux deb package includes

✅ **Standard installation to `/opt/SLightSFTP`**

✅ **Desktop entry** for application launchers

✅ **Uninstall** via `sudo apt remove slightsftp`

### Linux AppImage

✅ **No installation required** — just mark as executable and run:

```bash
chmod +x SLightSFTP-1.1.0.AppImage
./SLightSFTP-1.1.0.AppImage
```

## Icon Files

Place application icons at:
- `build/icon.ico` — Windows (256×256 recommended)
- `build/icon.png` — Linux (512×512 recommended)

If no icon is provided, the default Electron icon is used.

## Configuration

### Changing Default Installation Path

Edit `package.json` build configuration:

```json
{
  "build": {
    "msi": {
      "perMachine": true
    }
  }
}
```

### Changing Application Version

Update version in `package.json`:

```json
{
  "version": "1.0.0"
}
```

## Running After Installation

### Windows

1. **Desktop shortcut** — "SLightSFTP Server"
2. **Start Menu** — search for "SLightSFTP Server"
3. **Directly** — `C:\Program Files\SLightSFTP\bin\SLightSFTP.exe`

### Linux

1. **AppImage** — `./SLightSFTP-1.1.0.AppImage`
2. **deb install** — application launcher entry or run `slightsftp` from terminal
3. **Web server mode (any platform)** — `npm run start:web` then open `http://localhost:3000`

## Default Credentials

After first launch:
- **Username**: `admin`
- **Password**: `admin123`

## Troubleshooting

### Build Fails

1. Ensure all dependencies are installed:
   ```bash
   npm install
   ```

2. Clean and rebuild:

   **Windows (PowerShell)**
   ```powershell
   Remove-Item -Path dist, release -Recurse -Force
   npm run build
   npm run dist:win
   ```

   **Linux**
   ```bash
   rm -rf dist release
   npm run build
   npm run dist:linux
   ```

### Installation Fails

**Windows:** Run the MSI as Administrator. Check Windows Event Viewer for details.

**Linux (deb):** Run `sudo dpkg -i SLightSFTP-*.deb`. If dependencies are missing, run `sudo apt --fix-broken install`.

Ensure no other instance is already running before installing.

### Database Issues

If the database gets corrupted, delete it and restart (it will be recreated with defaults):

**Windows:** `C:\Program Files\SLightSFTP\config\config.db`

**Linux:** `~/.config/SLightSFTP/config.db` (AppImage) or `/opt/SLightSFTP/resources/config/config.db` (deb)

## Ports

The application uses:
- **Port 22** — SFTP
- **Port 21** — FTP
- **Port 3000** — Web GUI (configurable via `WEB_PORT`)

On both Windows and Linux, binding to ports below 1024 requires elevated privileges (Administrator on Windows, `root` or `CAP_NET_BIND_SERVICE` on Linux).

To allow the app to bind port 22/21 on Linux without running as root:

```bash
sudo setcap 'cap_net_bind_service=+ep' /path/to/slightsftp
```

Alternatively, configure listeners to use ports above 1024 (e.g. 2222 for SFTP, 2121 for FTP).

## Additional Resources

- [electron-builder documentation](https://www.electron.build/)
- [WiX Toolset](https://wixtoolset.org/) (Windows MSI)
- [AppImage](https://appimage.org/) (Linux universal package)
