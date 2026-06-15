@echo off
title Conveyer Treso
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed.
  echo Download and install it from https://nodejs.org ^(LTS version^), then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run - installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Check your internet connection and try again.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo Starting Conveyer Treso...
echo The app will open at http://localhost:3777 ^(keep this window open^)
echo To stop the app: close this window or press Ctrl+C
echo.
start "" cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:3777"
call npm run dev
pause
