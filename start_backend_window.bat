@echo off
setlocal EnableExtensions

cd /d "%~dp0backend"

set "AUTO_START_RUNTIME=0"
set "SERVER_LOG_STDOUT=1"
set "SERVER_LOG_STDOUT_FORCE=1"

call npm install
if errorlevel 1 exit /b %errorlevel%

call npm run dev
exit /b %errorlevel%
