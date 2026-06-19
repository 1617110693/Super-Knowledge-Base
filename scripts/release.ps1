# Local Knowledge Base — Full Release Build
# Produces a single Tauri installer containing everything.
# Prerequisites: python, uv, node, rust
# Usage: .\scripts\release.ps1 [version]

param([string]$Version = "0.1.0")

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot + "\.."
$Root = (Resolve-Path $Root).Path

Write-Host "=== Building Local Knowledge Base v$Version ===" -ForegroundColor Cyan

# 1. Bump version numbers
Write-Host "`n[1/5] Bumping version..." -ForegroundColor Yellow
$files = @(
    "$Root\package.json",
    "$Root\apps\desktop\package.json",
    "$Root\apps\desktop\src-tauri\tauri.conf.json",
    "$Root\apps\mcp-server\pyproject.toml",
    "$Root\services\python-backend\pyproject.toml"
)
foreach ($f in $files) {
    $content = Get-Content $f -Raw -Encoding UTF8
    $content = $content -replace '("version"\s*:\s*)"[^"]*"', "`$1`"$Version`""
    $content = $content -replace '(version\s*=\s*)"[^"]*"', "`$1`"$Version`""
    [System.IO.File]::WriteAllText((Resolve-Path $f).Path, $content, [System.Text.UTF8Encoding]::new($false))
}

# 2. Install dependencies
Write-Host "`n[2/5] Installing dependencies..." -ForegroundColor Yellow
Set-Location $Root
npm install
Push-Location $Root\apps\desktop; npm install; Pop-Location
Push-Location $Root\services\python-backend; uv sync; Pop-Location
Push-Location $Root\apps\mcp-server; uv sync; Pop-Location

# 3. Build Python backend into standalone exe (PyInstaller)
Write-Host "`n[3/5] Building knowledge-backend.exe..." -ForegroundColor Yellow
Push-Location $Root\services\python-backend
uv sync --extra build
.venv\Scripts\python.exe -m PyInstaller --onefile --noconsole --name knowledge-backend --paths src build_backend.py
$backendExe = "$Root\services\python-backend\dist\knowledge-backend.exe"
if (-not (Test-Path $backendExe)) {
    Write-Warning "PyInstaller backend build failed, falling back to uv run at runtime"
}
Pop-Location

# 4. Build MCP server into standalone exe (PyInstaller)
Write-Host "`n[4/5] Building local-kb-mcp.exe..." -ForegroundColor Yellow
Push-Location $Root\apps\mcp-server
uv sync --extra build
.venv\Scripts\python.exe -m PyInstaller --onefile --console --hide-console hide-early --name local-kb-mcp --paths src --copy-metadata fastmcp build_mcp.py
$mcpExe = "$Root\apps\mcp-server\dist\local-kb-mcp.exe"
if (-not (Test-Path $mcpExe)) {
    Write-Warning "PyInstaller MCP build failed, users can use uvx from source"
}
Pop-Location

# Copy sidecars to Tauri binaries directory
$binDir = "$Root\apps\desktop\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
if (Test-Path $backendExe) {
    Copy-Item $backendExe "$binDir\knowledge-backend-x86_64-pc-windows-msvc.exe" -Force
    Write-Host "  Copied knowledge-backend to Tauri binaries" -ForegroundColor Green
}
if (Test-Path $mcpExe) {
    Copy-Item $mcpExe "$binDir\local-kb-mcp-x86_64-pc-windows-msvc.exe" -Force
    Write-Host "  Copied local-kb-mcp to Tauri binaries" -ForegroundColor Green
}

# 5. Build Tauri desktop installer
Write-Host "`n[5/5] Building desktop installer..." -ForegroundColor Yellow
Push-Location $Root\apps\desktop
npm run tauri build
Pop-Location

Write-Host "`n=== Build Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Desktop installer:" -ForegroundColor White
Write-Host "  $Root\apps\desktop\src-tauri\target\release\bundle\" -ForegroundColor Cyan
Write-Host ""
Write-Host "The installer includes:" -ForegroundColor White
Write-Host "  - Desktop app (.exe)" -ForegroundColor Gray
Write-Host "  - Python backend (knowledge-backend.exe)" -ForegroundColor Gray
Write-Host "  - MCP server (local-kb-mcp.exe)" -ForegroundColor Gray
Write-Host ""
Write-Host "Users just run the installed app — no Python/uv/npm needed." -ForegroundColor Green
