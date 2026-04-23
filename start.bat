@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "BACKEND_PIDFILE=%ROOT%\backend\.cmd.pid"
set "FRONTEND_PIDFILE=%ROOT%\frontend\.cmd.pid"
set "BACKEND_RUNNER=%ROOT%\start_backend_window.bat"
set "FRONTEND_RUNNER=%ROOT%\start_frontend_window.bat"

call powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& {" ^
  "  $root = '%ROOT%';" ^
  "  $backendPidFile = Join-Path $root 'backend\.cmd.pid';" ^
  "  $frontendPidFile = Join-Path $root 'frontend\.cmd.pid';" ^
  "  $backendRunner = Join-Path $root 'start_backend_window.bat';" ^
  "  $frontendRunner = Join-Path $root 'start_frontend_window.bat';" ^
  "  function Test-PortListening([int]$port) {" ^
  "    return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue);" ^
  "  }" ^
  "  function Test-PidFile([string]$path) {" ^
  "    if (-not (Test-Path $path)) { return $false }" ^
  "    $procId = (Get-Content $path -ErrorAction SilentlyContinue | Select-Object -First 1).Trim();" ^
  "    if (-not $procId) { Remove-Item $path -Force -ErrorAction SilentlyContinue; return $false }" ^
  "    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue;" ^
  "    if ($null -eq $proc) { Remove-Item $path -Force -ErrorAction SilentlyContinue; return $false }" ^
  "    return $true" ^
  "  }" ^
  "  function Start-Window([string]$runnerPath, [string]$pidFile, [string]$label) {" ^
  "    Write-Host ('Starting ' + $label + ' with live logs in its own console...');" ^
  "    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue;" ^
  "    $title = 'exhaustion ' + $label;" ^
  "    $cmdLine = 'title ' + $title + ' && call \"' + $runnerPath + '\"';" ^
  "    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', $cmdLine) -PassThru;" ^
  "    Set-Content -Path $pidFile -Value $proc.Id;" ^
  "    Write-Host ($label + ' console PID ' + $proc.Id + '.');" ^
  "  }" ^
  "  if ((Test-PidFile $backendPidFile) -or (Test-PortListening 8080)) {" ^
  "    Write-Host 'Backend already running on port 8080.';" ^
  "  } else {" ^
  "    Start-Window $backendRunner $backendPidFile 'backend';" ^
  "  }" ^
  "  if ((Test-PidFile $frontendPidFile) -or (Test-PortListening 5173)) {" ^
  "    Write-Host 'Frontend already running on port 5173.';" ^
  "  } else {" ^
  "    Start-Window $frontendRunner $frontendPidFile 'frontend';" ^
  "  }" ^
  "}"

echo Start sequence launched.
exit /b 0
