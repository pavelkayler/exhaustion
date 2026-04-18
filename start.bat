@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "BACKEND_CMD_PIDFILE=%ROOT%\backend\.cmd.pid"
set "FRONTEND_CMD_PIDFILE=%ROOT%\frontend\.cmd.pid"

call :is_running "%BACKEND_CMD_PIDFILE%" 8080
if errorlevel 1 (
  echo Starting backend with live logs in its own console...
  call :launch_terminal "exhaustion backend" "set SERVER_LOG_STDOUT=1 && set SERVER_LOG_STDOUT_FORCE=1 && npm install && npm run dev" "%BACKEND_CMD_PIDFILE%"
) else (
  echo Backend already running on port 8080.
)

call :is_running "%FRONTEND_CMD_PIDFILE%" 5173
if errorlevel 1 (
  echo Starting frontend with live logs in its own console...
  call :launch_terminal "exhaustion frontend" "npm install && npm run dev" "%FRONTEND_CMD_PIDFILE%"
) else (
  echo Frontend already running on port 5173.
)

echo Start sequence launched.
exit /b 0

:is_running
set "PIDFILE=%~1"
set "PORT=%~2"
set "PID="
if exist "%PIDFILE%" (
  set /p PID=<"%PIDFILE%"
  set "PID=%PID: =%"
)
if not "%PID%"=="" (
  tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul 2>&1
  if not errorlevel 1 exit /b 0
  del /q "%PIDFILE%" >nul 2>&1
)
call :port_listening %PORT%
if not errorlevel 1 exit /b 0
exit /b 1

:port_listening
set "PORT=%~1"
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:launch_terminal
set "TITLE=%~1"
set "COMMAND=%~2"
set "PIDFILE=%~3"
set "WORKDIR=%ROOT%"
if /I "%TITLE%"=="exhaustion backend" set "WORKDIR=%ROOT%\backend"
if /I "%TITLE%"=="exhaustion frontend" set "WORKDIR=%ROOT%\frontend"
set "LAUNCH_PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$proc = Start-Process -FilePath 'cmd.exe' -WorkingDirectory '%WORKDIR%' -ArgumentList '/k', ('title %TITLE% ^&^& %COMMAND%') -PassThru; $proc.Id"`) do set "LAUNCH_PID=%%P"
if not "%LAUNCH_PID%"=="" (
  >"%PIDFILE%" echo %LAUNCH_PID%
  echo %TITLE% console PID %LAUNCH_PID%.
)
exit /b 0
