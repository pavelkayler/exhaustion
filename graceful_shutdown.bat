@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=8080"
set "BACKEND_DIR=%CD%\backend"
set "FRONTEND_DIR=%CD%\frontend"
set "BACKEND_PID=%CD%\backend\.pid"
set "FRONTEND_PID=%CD%\frontend\.pid"
set "BACKEND_PORT=8080"
set "FRONTEND_PORT=5173"
set "HELPER_PS1=%CD%\resolve_dev_root.ps1"

echo [1/3] Requesting backend shutdown...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& {" ^
  "  try {" ^
  "    Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:%PORT%/api/admin/shutdown' -TimeoutSec 5 | Out-Null;" ^
  "    Write-Host 'shutdown_sent';" ^
  "  } catch {" ^
  "    Write-Host ('shutdown_request_failed: ' + $_.Exception.Message);" ^
  "  }" ^
  "}"

echo [2/3] Waiting for backend to stop...
call :wait_for_exit "%BACKEND_PID%" backend 20 %BACKEND_PORT% "%BACKEND_DIR%" backend

echo [3/3] Stopping frontend...
call :stop_by_pidfile "%FRONTEND_PID%" frontend %FRONTEND_PORT% "%FRONTEND_DIR%" frontend

echo Shutdown complete.
exit /b 0

:wait_for_exit
set "PIDFILE=%~1"
set "LABEL=%~2"
set "SECONDS=%~3"
set "PORT=%~4"
set "WORKDIR=%~5"
set "KIND=%~6"
set "PID="
call :resolve_target_pid "%PIDFILE%" "%PORT%" "%WORKDIR%" "%KIND%"
set "PID=%RESOLVED_PID%"

if "%PID%"=="" (
  echo %LABEL% pid not found.
  exit /b 0
)

for /L %%i in (1,1,%SECONDS%) do (
  call :pid_running "%PID%"
  if errorlevel 1 (
    del /q "%PIDFILE%" >nul 2>&1
    echo %LABEL% stopped.
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)

echo %LABEL% is still running after %SECONDS%s. Stopping it now...
taskkill /PID %PID% /T /F >nul 2>&1
del /q "%PIDFILE%" >nul 2>&1
exit /b 0

:stop_by_pidfile
set "PIDFILE=%~1"
set "LABEL=%~2"
set "PORT=%~3"
set "WORKDIR=%~4"
set "KIND=%~5"
set "PID="
call :resolve_target_pid "%PIDFILE%" "%PORT%" "%WORKDIR%" "%KIND%"
set "PID=%RESOLVED_PID%"

if "%PID%"=="" (
  exit /b 0
)

call :pid_running "%PID%"
if errorlevel 1 (
  del /q "%PIDFILE%" >nul 2>&1
  exit /b 0
)

echo Stopping %LABEL% PID %PID%...
taskkill /PID %PID% /T /F >nul 2>&1
del /q "%PIDFILE%" >nul 2>&1
exit /b 0

:resolve_target_pid
set "PIDFILE=%~1"
set "PORT=%~2"
set "WORKDIR=%~3"
set "KIND=%~4"
set "RESOLVED_PID="

if exist "%PIDFILE%" (
  set /p RESOLVED_PID=<"%PIDFILE%"
  set "RESOLVED_PID=%RESOLVED_PID: =%"
)

if not "%RESOLVED_PID%"=="" (
  call :pid_running "%RESOLVED_PID%"
  if not errorlevel 1 exit /b 0
)

set "RESOLVED_PID="
call :find_dev_root_by_port "%PORT%" "%WORKDIR%" "%KIND%"
if not "%FOUND_PID%"=="" (
  set "RESOLVED_PID=%FOUND_PID%"
  >"%PIDFILE%" echo %RESOLVED_PID%
)
exit /b 0

:find_dev_root_by_port
set "PORT=%~1"
set "WORKDIR=%~2"
set "KIND=%~3"
set "FOUND_PID="

for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER_PS1%" -Port %PORT% -Workdir "%WORKDIR%" -Kind %KIND%`) do set "FOUND_PID=%%P"
exit /b 0

:pid_running
tasklist /FI "PID eq %~1" 2>nul | find "%~1" >nul
if errorlevel 1 exit /b 1
exit /b 0
