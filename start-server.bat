@echo off
rem One-click local server for Windows: double-click, then open the printed URL.
rem   start-server.bat            -> port 3000
rem   start-server.bat 4000       -> port 4000
rem   start-server.bat --rebuild  -> rebuild the client + server first
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Install Node.js 18 or newer from https://nodejs.org, then run this file again.
  echo.
  pause
  exit /b 1
)

node scripts\start-local.mjs %*
if errorlevel 1 pause
