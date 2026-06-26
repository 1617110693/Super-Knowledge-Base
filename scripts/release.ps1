# SKB (Super Knowledge Base) — Full Release Build
# Produces a single Tauri installer containing everything.
# Prerequisites: python, uv, node, rust
# Usage: .\scripts\release.ps1 [version]

param([string]$Version = "2.0.0")

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot + "\.."
$Root = (Resolve-Path $Root).Path

# Helper: run an external command without dying on stderr output.
# PowerShell's 2>&1 wraps stderr lines as ErrorRecords; with
# ErrorActionPreference=Stop that kills the script even on success.
# This temporarily switches to Continue so we can check $LASTEXITCODE.
function Invoke-Native([ScriptBlock]$ScriptBlock) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $ScriptBlock } catch {}
    $ErrorActionPreference = $prev
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE"
    }
}

Write-Host "=== Building SKB v$Version ===" -ForegroundColor Cyan

# 0. Kill any running backend processes that would lock files
Write-Host "`n[0/4] Stopping running processes..." -ForegroundColor Yellow
@("skb-mcp", "knowledge-backend") | ForEach-Object {
    try { Stop-Process -Name $_ -Force -ErrorAction SilentlyContinue } catch {}
}
$defaultPort = 17390
$portPids = (Get-NetTCPConnection -LocalPort $defaultPort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($procId in $portPids) {
    try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Seconds 1
Write-Host "  Done" -ForegroundColor Gray

# 1. Bump version numbers
Write-Host "`n[1/4] Bumping version..." -ForegroundColor Yellow
$files = @(
    "$Root\package.json",
    "$Root\apps\desktop\package.json",
    "$Root\apps\desktop\src-tauri\tauri.conf.json",
    "$Root\services\python-backend\pyproject.toml"
)
foreach ($f in $files) {
    $content = Get-Content $f -Raw -Encoding UTF8
    $content = $content -replace '("version"\s*:\s*)"[^"]*"', "`$1`"$Version`""
    $content = $content -replace '(version\s*=\s*)"[^"]*"', "`$1`"$Version`""
    [System.IO.File]::WriteAllText((Resolve-Path $f).Path, $content, [System.Text.UTF8Encoding]::new($false))
}

# 2. Install dependencies
Write-Host "`n[2/4] Installing dependencies..." -ForegroundColor Yellow
Set-Location $Root
Invoke-Native { npm install }
Push-Location $Root\apps\desktop; Invoke-Native { npm install }; Pop-Location

Push-Location $Root\services\python-backend
# Retry uv sync up to 3 times in case of file-lock issues
for ($i = 0; $i -lt 3; $i++) {
    try {
        Invoke-Native { uv sync --extra build }
        break
    } catch {
        Write-Host "    Retrying uv sync ($($i+1)/3)..." -ForegroundColor DarkYellow
        Start-Sleep -Seconds 2
    }
}
# Verify PyInstaller is available
Invoke-Native { .venv\Scripts\python.exe -c "import PyInstaller" }
Pop-Location

# 3. Build Python backend into a SINGLE standalone exe.
#    Default (no args)     -> REST API server
#    `knowledge-backend.exe mcp` -> MCP stdio server
#    --console is required so MCP mode has stdin/stdout;
#    --hide-console hide-early suppresses the window for REST API mode.
Write-Host "`n[3/4] Building knowledge-backend.exe (REST API + MCP)..." -ForegroundColor Yellow
Push-Location $Root\services\python-backend

Remove-Item -Recurse -Force "$Root\services\python-backend\dist" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$Root\services\python-backend\dist" | Out-Null

Invoke-Native {
    .venv\Scripts\python.exe -m PyInstaller --clean --noconfirm --paths src `
        --onefile --console --hide-console hide-early `
        --copy-metadata fastmcp `
        --copy-metadata fastmcp-slim `
        --copy-metadata mcp `
        --name knowledge-backend build_backend.py
}
$backendExe = "$Root\services\python-backend\dist\knowledge-backend.exe"
if (-not (Test-Path $backendExe)) {
    Write-Error "Backend exe not found after build"
    Pop-Location; exit 1
}
Write-Host "  OK knowledge-backend.exe ($([math]::Round((Get-Item $backendExe).Length/1MB, 1)) MB)" -ForegroundColor Green
Write-Host "     knowledge-backend.exe      -> REST API server" -ForegroundColor Gray
Write-Host "     knowledge-backend.exe mcp  -> MCP stdio server" -ForegroundColor Gray

Pop-Location

# 4. Copy sidecar + build Tauri installer
Write-Host "`n[4/4] Copying sidecar + building desktop installer..." -ForegroundColor Yellow
$binDir = "$Root\apps\desktop\src-tauri\binaries"
# Remove old MCP-only exe if present from a previous release
Remove-Item -Force "$binDir\skb-mcp*" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item $backendExe "$binDir\knowledge-backend-x86_64-pc-windows-msvc.exe" -Force
Write-Host "  Copied knowledge-backend to Tauri binaries" -ForegroundColor Green

Push-Location $Root\apps\desktop
Invoke-Native { npm run tauri build }
Pop-Location

Write-Host "`n=== Build Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Desktop installer:" -ForegroundColor White
Write-Host "  $Root\apps\desktop\src-tauri\target\release\bundle\" -ForegroundColor Cyan
Write-Host ""
Write-Host "The installer includes:" -ForegroundColor White
Write-Host "  - Desktop app (.exe)" -ForegroundColor Gray
Write-Host "  - knowledge-backend.exe  (REST API + MCP in one file)" -ForegroundColor Gray
Write-Host "      knowledge-backend.exe      -> REST API server" -ForegroundColor Gray
Write-Host "      knowledge-backend.exe mcp  -> MCP stdio server" -ForegroundColor Gray
Write-Host ""
Write-Host "Users just run the installed app - no Python/uv/npm needed." -ForegroundColor Green
