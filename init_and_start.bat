@echo off
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

start cmd /k "cd /d "%ROOT%\backend" && npm install && npm run dev"
timeout /t 2 /nobreak >nul
cd /d "%ROOT%\frontend"
call npm install
call npm run dev