# Publishing Releases

This guide explains how to build and publish SLightSFTP installers for Windows and Linux.

## 🚀 Recommended: Automated GitHub Actions (Easiest)

Use GitHub Actions for automated cross-platform building - no local setup required!

### Setup (One-time)

1. GitHub Actions workflow is already configured in `.github/workflows/release.yml`
2. No additional setup needed - it uses GitHub's built-in runners

### Create a Release

```bash
# Update version in package.json
# Then tag and push
git tag v1.1.0
git push origin v1.1.0
```

GitHub Actions will automatically:
- Build Windows installer on Windows runner
- Build Linux installers on Linux runner  
- Create GitHub Release
- Upload all installers as release assets

### Manual Trigger

You can also trigger builds manually from GitHub Actions tab in your repository.

## 🔧 Local Building (Advanced)

### Prerequisites

1. **GitHub Personal Access Token** (for automatic publishing)
   - Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Generate a new token with `repo` scope
   - Set environment variable: `export GH_TOKEN=your_github_token_here`

2. **Platform-specific dependencies**
   - **Linux:** Install Wine for cross-platform Windows builds
   - **Windows:** Native builds work out of the box
   - **macOS:** Additional setup may be required

### Fixing Wine Error on Linux

If you get "wine process failed ENOENT" when building Windows installers from Linux:

```bash
# Install Wine
sudo apt update
sudo apt install wine64 wine32

# Then try building again
npm run dist:win
```

### Building for Current Platform

```bash
# Build for your current platform
npm run dist
```

### Building for Specific Platforms

#### From Linux
```bash
# Install Wine first (required for Windows builds on Linux)
sudo apt update
sudo apt install wine64 wine32

# Build Linux installers (native)
npm run dist:linux

# Build Windows installer (requires Wine)
npm run dist:win
```

#### From Windows
```bash
# Build Windows installer (native)
npm run dist:win

# For Linux builds, use WSL or GitHub Actions
```

### Local Build with Manual Upload

```bash
# Build installers locally
npm run dist:win    # Windows MSI
npm run dist:linux  # Linux AppImage + DEB

# Then manually upload files from release/ directory to GitHub Releases
```

Built files will be in the `release/` directory.

### Automatic Release with GitHub Publishing (Local)

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

## 📦 Manual Release Process

If you prefer manual control:

1. **Build installers** (using GitHub Actions or locally)
2. **Create GitHub Release:**
   - Go to https://github.com/sujithsuranga/slightsftp/releases
   - Click "Draft a new release"
   - Tag version: `v1.1.0` (match package.json version)
   - Release title: `SLightSFTP v1.1.0`
   - Describe changes in release notes
   - Attach built files
3. **Publish the release**

## 📂 Built Files

After building, you'll find these files in the `release/` directory:

### Windows
- `SLightSFTP-1.1.0-setup.msi` - Windows MSI installer

### Linux  
- `SLightSFTP-1.1.0.AppImage` - Universal Linux package
- `slightsftp_1.1.0_amd64.deb` - Debian/Ubuntu package

## 🏷️ Version Management

Update version in `package.json` before building:

```json
{
  "version": "1.1.0"
}
```

## 🌐 Website Integration

The website automatically links to GitHub Releases:
- Download buttons point to: https://github.com/sujithsuranga/slightsftp/releases
- Users can download the appropriate installer for their platform
- No manual website updates needed when publishing new releases

## ⚡ Quick Start (Recommended Workflow)

1. **Update version** in package.json
2. **Commit changes** and push to GitHub
3. **Create and push tag:**
   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```
4. **GitHub Actions builds** all installers automatically
5. **Release is created** with all installers attached
6. **Users download** from your website's download buttons

This approach requires no local build setup and works reliably for all platforms!