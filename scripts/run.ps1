# Runs Dalang on native Windows. Usage (from anywhere): run.cmd [-Dev] [-Install]
#   default  build (tsc) then run dist/main.js
#   -Dev     run src/main.ts directly through tsx, no build
#   -Install force `npm ci` even when node_modules looks current
# On the first run it writes .env from .env.example with a fresh LZVR_TOKEN. The codex, claude, gh and glab binaries are
# found on PATH / in the global npm folder when .env does not set CODEX_BIN, CLAUDE_BIN, GH_BIN or GLAB_BIN, since a
# headless spawn cannot run the .cmd shims npm installs. Written for Windows PowerShell 5.1 and PowerShell 7.
param([switch]$Dev, [switch]$Install)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host $msg -ForegroundColor DarkGray }

# Keys set (uncommented) in .env, as a hashtable.
function Read-EnvFile($path) {
  $vars = @{}
  if (Test-Path $path) {
    foreach ($line in Get-Content $path) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { $vars[$Matches[1]] = $Matches[2].Trim('"', "'") }
    }
  }
  return $vars
}

# ---------- Node ----------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js was not found on PATH. Install Node >= 22.13.' }
$nodeVersion = [version]((node -v).TrimStart('v'))
if ($nodeVersion -lt [version]'22.13.0') { Fail "Node $nodeVersion is too old: Dalang needs >= 22.13." }

# ---------- dependencies ----------
$installed = 'node_modules/.package-lock.json'
if ($Install -or -not (Test-Path $installed) -or (Get-Item 'package-lock.json').LastWriteTime -gt (Get-Item $installed).LastWriteTime) {
  Info 'Installing dependencies (npm ci)...'
  npm ci
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed.' }
}

# ---------- .env ----------
if (-not (Test-Path '.env')) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  $text = (Get-Content '.env.example' -Raw) -replace '(?m)^LZVR_TOKEN=.*$', "LZVR_TOKEN=$token"
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), $text)
  Write-Host "Created .env with a new LZVR_TOKEN (sign in with it under 'Use an access token'):" -ForegroundColor Yellow
  Write-Host "  $token" -ForegroundColor Yellow
  Write-Host "Edit .env to set WORKSPACE_ROOT, LZVR_OWNER_EMAILS and the rest." -ForegroundColor Yellow
}
$envFile = Read-EnvFile '.env'

# ---------- agent and forge binaries ----------
# Node's --env-file never overrides a variable already in the environment, so only fill what neither sets.
$npmRoot = $null
function Get-NpmRoot {
  if (-not $script:npmRoot) { $script:npmRoot = (npm root -g 2>$null | Select-Object -First 1) }
  return $script:npmRoot
}
function Find-Exe($name, [scriptblock]$fallback) {
  $cmd = Get-Command "$name.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  if ($fallback) { return & $fallback }
  return $null
}
$bins = [ordered]@{
  CODEX_BIN = { Find-Exe 'codex' {
      $pkg = Join-Path (Get-NpmRoot) '@openai/codex'
      if (Test-Path $pkg) { Get-ChildItem $pkg -Recurse -Filter 'codex.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
    } }
  CLAUDE_BIN = { Find-Exe 'claude' {
      $exe = Join-Path (Get-NpmRoot) '@anthropic-ai/claude-code/bin/claude.exe'
      if (Test-Path $exe) { $exe }
    } }
  GH_BIN = { Find-Exe 'gh' $null }
  GLAB_BIN = { Find-Exe 'glab' $null }
}
foreach ($key in $bins.Keys) {
  if ($envFile.ContainsKey($key) -or (Test-Path "env:$key")) { continue }
  $found = & $bins[$key]
  if ($found) { Set-Item "env:$key" $found; Info "$key = $found" }
  elseif ($key -eq 'CODEX_BIN') { Write-Host 'codex.exe not found: Codex chats fail until you install it (npm i -g @openai/codex) or set CODEX_BIN in .env.' -ForegroundColor Yellow }
}

# ---------- run ----------
$hostName = if ($env:HOST) { $env:HOST } elseif ($envFile.HOST) { $envFile.HOST } else { '127.0.0.1' }
$port = if ($env:PORT) { $env:PORT } elseif ($envFile.PORT) { $envFile.PORT } else { '9876' }
if ($Dev) {
  Write-Host "Starting Dalang (dev) on http://${hostName}:$port  (Ctrl+C to stop)" -ForegroundColor Green
  node --env-file-if-exists=.env --import tsx src/main.ts
} else {
  Info 'Building (tsc)...'
  npm run build --silent
  if ($LASTEXITCODE -ne 0) { Fail 'Build failed.' }
  Write-Host "Starting Dalang on http://${hostName}:$port  (Ctrl+C to stop)" -ForegroundColor Green
  node --env-file-if-exists=.env dist/main.js
}
exit $LASTEXITCODE
