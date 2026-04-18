@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "BACKEND_PORT=8080"
set "FRONTEND_PORT=5173"
set "BACKEND_CMD_PIDFILE=%ROOT%\backend\.cmd.pid"
set "FRONTEND_CMD_PIDFILE=%ROOT%\frontend\.cmd.pid"

echo [1/3] Requesting backend shutdown...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& {" ^
  "  try {" ^
  "    Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:%BACKEND_PORT%/api/admin/shutdown' -TimeoutSec 5 | Out-Null;" ^
  "    Write-Host 'shutdown_sent';" ^
  "  } catch {" ^
  "    Write-Host ('shutdown_request_failed: ' + $_.Exception.Message);" ^
  "  }" ^
  "}"

echo [2/3] Stopping backend...
call :stop_target "%BACKEND_CMD_PIDFILE%" %BACKEND_PORT% backend

echo [3/3] Stopping frontend...
call :stop_target "%FRONTEND_CMD_PIDFILE%" %FRONTEND_PORT% frontend

echo Shutdown complete.
exit /b 0

:stop_target
set "PIDFILE=%~1"
set "PORT=%~2"
set "LABEL=%~3"
set "PID="

if exist "%PIDFILE%" (
  set /p PID=<"%PIDFILE%"
  set "PID=%PID: =%"
)

if not "%PID%"=="" (
  tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul 2>&1
  if not errorlevel 1 (
    echo Stopping %LABEL% console PID %PID%...
    taskkill /PID %PID% /T /F >nul 2>&1
    del /q "%PIDFILE%" >nul 2>&1
    timeout /t 1 /nobreak >nul
  ) else (
    del /q "%PIDFILE%" >nul 2>&1
  )
)

call :kill_by_port %PORT% %LABEL%
exit /b 0

:kill_by_port
set "PORT=%~1"
set "LABEL=%~2"
set "PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  set "PID=%%P"
  goto :kill_found
)
echo %LABEL% not running on port %PORT%.
exit /b 0

:kill_found
echo Stopping %LABEL% listener PID %PID%...
taskkill /PID %PID% /T /F >nul 2>&1
exit /b 0
