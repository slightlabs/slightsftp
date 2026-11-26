
# run from the repository root, wherever the script is started from
Set-Location (Join-Path $PSScriptRoot '..')
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  SLightSFTP - Automated Test Runner" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if server is already running
$sftpPort = 2222
$ftpPort = 2121

Write-Host "Checking if servers are running..." -ForegroundColor Yellow

$sftpRunning = $false
$ftpRunning = $false

try {
    $connection = Test-NetConnection -ComputerName localhost -Port $sftpPort -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
    $sftpRunning = $connection
}
catch {
    $sftpRunning = $false
}

try {
    $connection = Test-NetConnection -ComputerName localhost -Port $ftpPort -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
    $ftpRunning = $connection
}
catch {
    $ftpRunning = $false
}

if ($sftpRunning -and $ftpRunning) {
    Write-Host "Server is already running!" -ForegroundColor Green
    Write-Host "  - SFTP: localhost:$sftpPort" -ForegroundColor Green
    Write-Host "  - FTP:  localhost:$ftpPort" -ForegroundColor Green
    Write-Host ""
    Write-Host "Running tests in 2 seconds..." -ForegroundColor Yellow
    Write-Host ""
    Start-Sleep -Seconds 2
    
    node dist-tools/tools/test-client.js
    exit $LASTEXITCODE
}


Write-Host "Server is not running. Starting server..." -ForegroundColor Yellow
Write-Host ""

# Start the server in background
Write-Host "Starting SLightSFTP server..." -ForegroundColor Cyan
$serverJob = Start-Job -ScriptBlock {
    Set-Location $using:PWD
    npm start 2>&1
}

Write-Host "Server started with Job ID: $($serverJob.Id)" -ForegroundColor Green
Write-Host "Waiting for server to initialize..." -ForegroundColor Yellow
Write-Host ""

# Wait for servers to start (max 30 seconds)
$maxWait = 30
$waited = 0
$serversReady = $false

while (($waited -lt $maxWait) -and (-not $serversReady)) {
    Start-Sleep -Seconds 1
    $waited++
    
    try {
        $sftpOk = Test-NetConnection -ComputerName localhost -Port $sftpPort -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
        $ftpOk = Test-NetConnection -ComputerName localhost -Port $ftpPort -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
        
        if ($sftpOk -and $ftpOk) {
            $serversReady = $true
            Write-Host ""
            Write-Host "Servers are ready!" -ForegroundColor Green
            Write-Host "  - SFTP: localhost:$sftpPort" -ForegroundColor Green
            Write-Host "  - FTP:  localhost:$ftpPort" -ForegroundColor Green
            Write-Host "  - Startup time: $waited seconds" -ForegroundColor Green
            Write-Host ""
        }
        else {
            Write-Host "." -NoNewline -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "." -NoNewline -ForegroundColor Yellow
    }
}

if (-not $serversReady) {
    Write-Host ""
    Write-Host ""
    Write-Host "Server failed to start within $maxWait seconds" -ForegroundColor Red
    Write-Host ""
    Write-Host "Server output:" -ForegroundColor Yellow
    Write-Host ""
    Receive-Job -Job $serverJob
    Stop-Job -Job $serverJob
    Remove-Job -Job $serverJob
    exit 1
}

Write-Host "Waiting 2 more seconds for full initialization..." -ForegroundColor Yellow
Write-Host ""
Start-Sleep -Seconds 2

# Run the tests
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Running Comprehensive Tests" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

node dist-tools/tools/test-client.js
$testExitCode = $LASTEXITCODE

# Keep server running and show output
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Tests Completed" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Server is still running (Job ID: $($serverJob.Id))" -ForegroundColor Green
Write-Host ""
Write-Host "Options:" -ForegroundColor Yellow
Write-Host "  - Press Ctrl+C to stop this script (server will keep running)" -ForegroundColor White
Write-Host "  - To stop the server later, run:" -ForegroundColor White
Write-Host "    Stop-Job -Id $($serverJob.Id); Remove-Job -Id $($serverJob.Id)" -ForegroundColor White
Write-Host ""
Write-Host "Waiting 10 seconds, then stopping server..." -ForegroundColor Yellow

Start-Sleep -Seconds 10

Write-Host ""
Write-Host "Stopping server..." -ForegroundColor Yellow
Stop-Job -Job $serverJob
Remove-Job -Job $serverJob
Write-Host "Server stopped" -ForegroundColor Green
Write-Host ""

exit $testExitCode
