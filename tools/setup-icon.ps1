# SLight SFTP Icon Setup Script
# 
# Instructions:
# 1. Save the provided SLight FTP/SFTP icon image to: assets\icon-source.png
# 2. Run this script to convert it to all needed formats

param(
    [string]$SourceIcon = "assets\icon-source.png"
)

# run from the repository root, wherever the script is started from
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host "=== SLight SFTP Icon Setup ===" -ForegroundColor Cyan
Write-Host ""

# Check if source icon exists
if (-not (Test-Path $SourceIcon)) {
    Write-Host "ERROR: Source icon not found at: $SourceIcon" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please save the provided icon image to: $SourceIcon" -ForegroundColor Yellow
    Write-Host "Then run this script again." -ForegroundColor Yellow
    exit 1
}

Write-Host "Found source icon: $SourceIcon" -ForegroundColor Green

# Create directories
$dirs = @("assets", "build", "resources")
foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
        Write-Host "Created directory: $dir" -ForegroundColor Green
    }
}

# Copy to assets directory
Copy-Item $SourceIcon "assets\icon.png" -Force
Write-Host "Copied to: assets\icon.png" -ForegroundColor Green

# Generate ICO file for Windows
Write-Host ""
Write-Host "Generating ICO file for MSI installer..." -ForegroundColor Cyan

try {
    # Use npx icon-gen to create ICO
    npx --yes icon-gen@5.0.0 -i $SourceIcon -o build --ico
    Write-Host "Generated: build\icon.ico" -ForegroundColor Green
    
    # Also create app.ico for the application
    if (Test-Path "build\app.ico") {
        Copy-Item "build\app.ico" "assets\app.ico" -Force
        Write-Host "Copied: assets\app.ico" -ForegroundColor Green
    }
    
} catch {
    Write-Host "WARNING: Could not generate ICO file automatically" -ForegroundColor Yellow
    Write-Host "You may need to convert the PNG to ICO manually" -ForegroundColor Yellow
}

# Copy to resources for packaged app
Copy-Item $SourceIcon "resources\icon.png" -Force
Write-Host "Copied to: resources\icon.png" -ForegroundColor Green

Write-Host ""
Write-Host "=== Icon Setup Complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Icon locations:" -ForegroundColor Cyan
Write-Host "  - Application window: assets\icon.png" -ForegroundColor White
Write-Host "  - MSI installer: build\icon.ico" -ForegroundColor White
Write-Host "  - Packaged app: resources\icon.png" -ForegroundColor White
Write-Host ""
Write-Host "Now rebuild the application with: npm run build" -ForegroundColor Yellow
