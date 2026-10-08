# CrewBus Desktop Installer for Windows
# Usage:
#   irm https://raw.githubusercontent.com/eamonpluto/crewbus/master/install.ps1 | iex
# Or:
#   irm https://eamonpluto.github.io/crewbus/install.ps1 | iex

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ========================================" -ForegroundColor DarkGreen
Write-Host "    CrewBus Desktop Installer (Windows)  " -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor DarkGreen
Write-Host ""

$repo = "eamonpluto/crewbus"
$apiUrl = "https://api.github.com/repos/$repo/releases"

Write-Host "==> Checking for latest desktop release..." -ForegroundColor Cyan

try {
    $releases = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "CrewBus-Installer" }
} catch {
    Write-Error "Failed to fetch release list from GitHub API: $_"
    exit 1
}

# Find the latest desktop release (tag matching desktop-v*)
$desktopRelease = $releases | Where-Object { $_.tag_name -like "desktop-v*" -and -not $_.draft } | Select-Object -First 1

if (-not $desktopRelease) {
    # Fallback to any desktop release
    $desktopRelease = $releases | Where-Object { $_.tag_name -like "desktop-v*" } | Select-Object -First 1
}

if (-not $desktopRelease) {
    Write-Error "Could not find a desktop release on GitHub ($repo)."
    exit 1
}

$version = $desktopRelease.tag_name
Write-Host "==> Found release: $version" -ForegroundColor Green

# Find the 64-bit setup executable asset
$asset = $desktopRelease.assets | Where-Object { $_.name -like "*_x64-setup.exe" -or $_.name -like "*setup*.exe" } | Select-Object -First 1

if (-not $asset) {
    Write-Error "No Windows setup executable found in release $version."
    exit 1
}

$downloadUrl = $asset.browser_download_url
$tempDir = [System.IO.Path]::GetTempPath()
$installerPath = Join-Path $tempDir $asset.name

$sizeMb = [math]::Round($asset.size / 1MB, 1)
Write-Host "==> Downloading $($asset.name) ($sizeMb MB)..." -ForegroundColor Cyan

try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $installerPath -UseBasicParsing
} catch {
    Write-Error "Download failed: $_"
    exit 1
}

Write-Host "==> Launching CrewBus installer..." -ForegroundColor Green
try {
    # Start the NSIS installer (currentUser: no admin prompt required)
    $process = Start-Process -FilePath $installerPath -PassThru -Wait
    if ($process.ExitCode -eq 0) {
        Write-Host ""
        Write-Host "  [+] CrewBus $version installed successfully!" -ForegroundColor Green
        Write-Host "  [+] You can now launch CrewBus from your Start Menu or Desktop shortcut." -ForegroundColor Cyan
        Write-Host ""
    } else {
        Write-Warning "Installer exited with code: $($process.ExitCode)"
    }
} catch {
    Write-Error "Failed to launch installer: $_"
} finally {
    if (Test-Path $installerPath) {
        Remove-Item -Path $installerPath -Force -ErrorAction SilentlyContinue
    }
}
