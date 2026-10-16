# Runs Dalang in the background at Windows logon through a Task Scheduler task. Usage: autostart.cmd <action>
#   install    register the "Dalang" task (runs scripts\run.ps1 hidden at logon, log in state\autostart.log) and start it
#   restart    git pull --ff-only, stop the task, free the port, start it again (run.ps1 rebuilds; -NoPull skips the pull)
#   stop       stop the task and free the port
#   status     task state, whether the port is listening, and the end of the log
#   uninstall  stop and unregister the task
# The task runs as you, only while you are logged in, so PATH, the global npm folder and the codex / claude / gh / glab
# sign-ins in your profile are all there. Do not run restart or stop from a Dalang chat: it stops the server running it.
param(
  [Parameter(Position = 0)][ValidateSet('install', 'restart', 'stop', 'status', 'uninstall')][string]$Action = 'status',
  [switch]$NoPull
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$taskName = 'Dalang'
$log = Join-Path $repo 'state\autostart.log'

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host $msg -ForegroundColor DarkGray }

function Get-Port {
  if ($env:PORT) { return [int]$env:PORT }
  if (Test-Path '.env') {
    foreach ($line in Get-Content '.env') {
      if ($line -match '^\s*PORT\s*=\s*"?''?(\d+)') { return [int]$Matches[1] }
    }
  }
  return 9876
}
$port = Get-Port

function Get-Listener { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 }
function Get-Task { Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
function Require-Task { if (-not (Get-Task)) { Fail "No '$taskName' task yet: run autostart.cmd install first." } }

# Stops the task, then waits for the port to close. A node still holding it after that is killed; anything else is not.
function Stop-Dalang {
  if ((Get-Task).State -eq 'Running') { Info "Stopping task '$taskName'..."; Stop-ScheduledTask -TaskName $taskName }
  # Stop-ScheduledTask ends only conhost: the task's powershell and its npm / node children live on. Kill that tree,
  # found by the command line the install action registers (run.ps1 piped into the log), so a run.cmd by hand is spared.
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like "*$repo\scripts\run.ps1*" -and $_.CommandLine -like "*$log*" } |
    ForEach-Object { Info "Killing leftover run.ps1 tree (pid $($_.ProcessId))..."; taskkill /T /F /PID $_.ProcessId | Out-Null }
  for ($i = 0; $i -lt 20 -and (Get-Listener); $i++) { Start-Sleep -Milliseconds 500 }
  $listener = Get-Listener
  if (-not $listener) { return }
  $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') {
    Info "Killing leftover node (pid $($proc.Id)) on port $port..."
    Stop-Process -Id $proc.Id -Force
    Start-Sleep -Seconds 1
  } else {
    Fail "Port $port is held by $($proc.ProcessName) (pid $($listener.OwningProcess)), not Dalang's node: free it first."
  }
}

# npm ci here in the console, not in the task: under conhost --headless an install script that spawns cmd.exe (ssh2's)
# dies with 0xC0000142. Same staleness check as run.ps1, so the task then skips it.
function Install-Deps {
  $installed = 'node_modules/.package-lock.json'
  if ((Test-Path $installed) -and (Get-Item 'package-lock.json').LastWriteTime -le (Get-Item $installed).LastWriteTime) { return }
  Info 'Installing dependencies (npm ci)...'
  npm ci
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed.' }
}

# Starts the task and waits for the port; the build runs first, so this can take a while.
function Start-Dalang {
  Start-ScheduledTask -TaskName $taskName
  Info "Started task '$taskName', waiting for port $port (building first)..."
  for ($i = 0; $i -lt 180; $i++) {
    if (Get-Listener) { Write-Host "Dalang is up on port $port." -ForegroundColor Green; return }
    if ((Get-Task).State -ne 'Running') { break }
    Start-Sleep -Seconds 1
  }
  Write-Host "Dalang did not come up on port $port. End of $log`:" -ForegroundColor Red
  if (Test-Path $log) { Get-Content $log -Tail 20 }
  exit 1
}

switch ($Action) {
  'install' {
    if (-not (Test-Path '.env')) { Fail 'No .env yet: run run.cmd once first, it prints the new LZVR_TOKEN.' }
    New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
    $command = "& '$repo\scripts\run.ps1' *>&1 | Out-File -FilePath '$log' -Encoding utf8"
    # conhost --headless gives it no window at all: with Windows Terminal as the default terminal (the Windows 11
    # default), -WindowStyle Hidden still leaves a terminal window open.
    $taskAction = New-ScheduledTaskAction -Execute 'conhost.exe' -WorkingDirectory $repo `
      -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$command`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    if (Get-Task) { Stop-Dalang; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings | Out-Null
    Info "Registered task '$taskName': it starts at every logon."
    if (Get-Listener) { Fail "Port $port is already in use (Dalang started by hand?): stop it, then autostart.cmd restart -NoPull." }
    Install-Deps
    Start-Dalang
  }
  'restart' {
    Require-Task
    if (-not $NoPull) {
      Info 'git pull --ff-only...'
      git pull --ff-only
      if ($LASTEXITCODE -ne 0) { Fail 'git pull failed: fix it (or use -NoPull) and retry. Dalang was left running.' }
    }
    Stop-Dalang
    Install-Deps
    Start-Dalang
  }
  'stop' { Require-Task; Stop-Dalang; Write-Host 'Dalang stopped.' -ForegroundColor Green }
  'status' {
    $task = Get-Task
    if (-not $task) { Write-Host "No '$taskName' task (autostart.cmd install registers it)." } else { Write-Host "Task '$taskName': $($task.State)" }
    if (Get-Listener) { Write-Host "Port ${port}: listening" -ForegroundColor Green } else { Write-Host "Port ${port}: not listening" -ForegroundColor Yellow }
    if (Test-Path $log) { Info "End of ${log}:"; Get-Content $log -Tail 10 }
  }
  'uninstall' {
    Require-Task
    Stop-Dalang
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Task '$taskName' removed." -ForegroundColor Green
  }
}
