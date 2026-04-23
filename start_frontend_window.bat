@echo off
setlocal EnableExtensions

cd /d "%~dp0frontend"

call npm install
if errorlevel 1 exit /b %errorlevel%

call npm run dev
exit /b %errorlevel%
