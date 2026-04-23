$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPidFile = Join-Path $root 'backend\.cmd.pid'
$frontendPidFile = Join-Path $root 'frontend\.cmd.pid'

function Stop-ByPidFile([string]$pidFile, [string]$label) {
  if (-not (Test-Path $pidFile)) { return }
  $rawPidText = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue
  $match = [regex]::Match([string]$rawPidText, '\d+')
  $targetPid = if ($match.Success) { [int]$match.Value } else { $null }
  if ($null -eq $targetPid) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    return
  }
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -ne $proc) {
    Write-Host ('Stopping ' + $label + ' console PID ' + $targetPid + '...')
    cmd.exe /c ('taskkill /PID ' + $targetPid + ' /T /F') | Out-Null
    Start-Sleep -Milliseconds 500
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

function Stop-ByPort([int]$port, [string]$label) {
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  if ($null -eq $listeners) {
    Write-Host ($label + ' not running on port ' + $port + '.')
    return
  }
  $owningPids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($owningPid in $owningPids) {
    Write-Host ('Stopping ' + $label + ' listener PID ' + $owningPid + '...')
    cmd.exe /c ('taskkill /PID ' + $owningPid + ' /T /F') | Out-Null
  }
}

function Stop-ByWindowTitle([string]$needle, [string]$label) {
  Get-Process | Where-Object {
    $_.MainWindowTitle -and $_.MainWindowTitle -like ('*' + $needle + '*')
  } | ForEach-Object {
    Write-Host ('Closing ' + $label + ' window PID ' + $_.Id + '...')
    cmd.exe /c ('taskkill /PID ' + $_.Id + ' /T /F') | Out-Null
  }
}

function Wait-PortClosed([int]$port, [string]$label) {
  for ($i = 0; $i -lt 5; $i++) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if ($null -eq $listener) {
      Write-Host ($label + ' stopped on port ' + $port + '.')
      return
    }
    Start-Sleep -Seconds 1
  }
  Write-Host ('WARNING: ' + $label + ' still appears to be listening on port ' + $port + '.')
}

Write-Host '[1/3] Requesting backend shutdown...'
try {
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8080/api/admin/shutdown' -TimeoutSec 5 | Out-Null
  Write-Host 'shutdown_sent'
} catch {
  $message = [string]$_.Exception.Message
  if ($message -notmatch 'timed out' -and $message -notmatch 'timeout') {
    Write-Host ('shutdown_request_failed: ' + $message)
  }
}

Write-Host '[2/3] Stopping backend...'
Stop-ByPidFile $backendPidFile 'backend'
Stop-ByPort 8080 'backend'
Stop-ByWindowTitle 'exhaustion backend' 'backend'
Wait-PortClosed 8080 'backend'

Write-Host '[3/3] Stopping frontend...'
Stop-ByPidFile $frontendPidFile 'frontend'
Stop-ByPort 5173 'frontend'
Stop-ByWindowTitle 'exhaustion frontend' 'frontend'
Wait-PortClosed 5173 'frontend'

Write-Host 'Shutdown complete.'
