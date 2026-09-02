# Publishing Releases

This guide explains how to build and publish SLightSFTP installers for Windows and Linux.

## Prerequisites

1. **GitHub Personal Access Token** (for automatic publishing)
   - Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Generate a new token with `repo` scope
   - Set environment variable: `export GH_TOKEN=your_token_here`

2. **Build Dependencies**
   - For Windows: Windows machine or cross-platform build setup
   - For Linux: Linux machine with required build tools

## Building Installers

### Local Build (Manual Upload)

```bash
# Build for current platform
npm run dist

# Build for Windows (from Linux/Mac)
npm run dist:win

# Build for Linux (from Windows/Mac)  
npm run dist:linux
```

Built files will be in the `release/` directory.

### Automatic Release with GitHub Publishing

```bash
# Set your GitHub token
export GH_TOKEN=your_github_token_here

# Build and publish to GitHub Releases
npm run release
```

This will:
1. Build installers for the current platform
2. Create a new GitHub Release
3. Upload the installers as release assets
4. Tag the release with the version from package.json

## Manual Release Process

If you prefer manual control:

1. **Build installers:**
   ```bash
   npm run dist:win    # Windows MSI
   npm run dist:linux  # Linux AppImage + DEB
   ```

2. **Create GitHub Release:**
   - Go to https://github.com/sujithsuranga/slightsftp/releases
   - Click "Draft a new release"
   - Tag version: `v1.1.0` (match package.json version)
   - Release title: `SLightSFTP v1.1.0`
   - Describe changes in release notes
   - Attach built files from `release/` directory

3. **Publish the release**

## Built Files

After building, you'll find these files in the `release/` directory:

### Windows
- `SLightSFTP-1.1.0-setup.msi` - Windows MSI installer

### Linux  
- `SLightSFTP-1.1.0.AppImage` - Universal Linux package
- `slightsftp_1.1.0_amd64.deb` - Debian/Ubuntu package

## Version Management

Update version in `package.json` before building:

```json
{
  "version": "1.1.0"
}
```

## Cross-Platform Building

To build for multiple platforms from one machine, you may need additional setup:

### Building Windows from Linux
```bash
npm install --save-dev electron-builder@latest
npm run dist:win --x64 --wine
```

### Building Linux from Windows  
Use WSL or a Linux VM for best results.

## Website Integration

The website automatically links to GitHub Releases:
- Download buttons point to: https://github.com/sujithsuranga/slightsftp/releases
- Users can download the appropriate installer for their platform
- No manual website updates needed when publishing new releases

## Automated CI/CD (Optional)

For fully automated releases, you can set up GitHub Actions:

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags:
      - 'v*'
jobs:
  release:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
      - run: npm ci
      - run: npm run release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

This will automatically build and publish releases when you push version tags.