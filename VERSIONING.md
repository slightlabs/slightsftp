# Version Management

This project uses automatic version bumping and tagging for every commit.

## 🔄 How It Works

### Automatic Version Bumping
- Every commit automatically increments the patch version (1.1.x)
- Version format: `MAJOR.MINOR.PATCH` (e.g., 1.1.1, 1.1.2, 1.1.3)
- Version is stored in `package.json` and updated before each commit

### Automatic Tagging
- Every commit automatically creates a local git tag
- Tag format: `vVERSION` (e.g., v1.1.1, v1.1.2)
- Tags are created locally, not pushed automatically

## 🚀 Usage

### Normal Development Workflow

```bash
# Make your changes
git add .
git commit -m "Your commit message"

# The hooks will automatically:
# 1. Bump version in package.json (1.1.1 → 1.1.2)
# 2. Create local tag (v1.1.2)
# 3. Include version bump in the commit
```

### Pushing Changes

```bash
# Push commits (without tags)
git push origin master

# Push tags when ready for release
git push origin --tags
```

### Creating Releases

When you want to create a release:

```bash
# Push your tags to trigger GitHub Actions
git push origin --tags

# This will:
# 1. Trigger GitHub Actions workflow
# 2. Build installers for Windows and Linux
# 3. Create GitHub Release
# 4. Upload installers as release assets
```

## 🎯 Release Strategy

### Development Phase
- Commit regularly with automatic version bumps
- Tags accumulate locally (v1.1.1, v1.1.2, v1.1.3, ...)
- Push commits without tags for normal development

### Release Phase
- When ready for release, push tags: `git push origin --tags`
- GitHub Actions builds installers for the latest tag
- Choose which tags to release based on stability/features

### Manual Version Control

If you need to manually control version bumps:

```bash
# Skip auto-bumping for this commit
git commit --no-verify -m "Your message"

# Manually set version
npm version patch  # 1.1.1 → 1.1.2
npm version minor  # 1.1.1 → 1.2.0
npm version major  # 1.1.1 → 2.0.0
```

## 📋 Current Version

Current version in package.json: `1.1.1`

## 🔧 Hooks Configuration

The system uses git hooks:
- `pre-commit`: Bumps version before commit
- `post-commit`: Creates tag after commit

Both hooks are located in `.git/hooks/` and are executable.

## ⚠️ Important Notes

1. **Tags are local only** - They must be manually pushed when ready for release
2. **Version bumps are automatic** - Every commit increments the patch version
3. **GitHub Actions trigger** - Only when tags are pushed to GitHub
4. **Selective releases** - You can choose which tags to push for releases

## 🔄 Example Workflow

```bash
# Development commit 1
git add .
git commit -m "Add new feature"
# → Version: 1.1.1 → 1.1.2, Tag: v1.1.2 created locally

# Development commit 2  
git add .
git commit -m "Fix bug"
# → Version: 1.1.2 → 1.1.3, Tag: v1.1.3 created locally

# Push commits (no tags)
git push origin master
# → Commits pushed, tags still local

# Ready for release - push tags
git push origin --tags
# → Tags pushed, GitHub Actions triggered
# → Installers built and released
```