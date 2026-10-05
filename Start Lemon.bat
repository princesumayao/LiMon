@echo off
title Lemon Launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is not installed or not on PATH. Install it from nodejs.org, then try again.
  pause
  exit /b 1
)

REM Guard against double-launches (e.g. double-clicking the silent .vbs
REM twice without realizing the first click already started it) leaving
REM multiple orphaned copies running in the background. If it already
REM looks up, don't start a second copy - just open it.
netstat -ano | findstr ":3000 " | findstr LISTENING >nul
if not errorlevel 1 (
  set RUNNING_MODE=unknown
  if exist ".limon-mode" set /p RUNNING_MODE=<".limon-mode"
  if /I not "%RUNNING_MODE%"=="real" (
    echo.
    echo [!] Lemon already looks like it's running, but in %RUNNING_MODE% mode - not real mode.
    echo     Opening this now will NOT switch it - it just shows you the %RUNNING_MODE%
    echo     instance that's already up. If you actually meant to switch to real
    echo     mode, close this window and stop the other instance first
    echo     ^(taskkill /F /IM node.exe^), then run this launcher again.
    echo.
    pause
  )
  echo Lemon already looks like it's running - opening it instead of starting a second copy.
  start "" http://localhost:3000/login
  exit /b 0
)

if not exist node_modules\concurrently (
  echo First run: installing packages, this can take a minute...
  call npm run install:all
)
if not exist backend\node_modules (
  call npm --prefix backend install
)

netstat -ano | findstr ":3306 " | findstr LISTENING >nul
if errorlevel 1 echo [!] MySQL does not seem to be running on port 3306. Start the MySQL service first.
netstat -ano | findstr ":1883 " | findstr LISTENING >nul
if errorlevel 1 echo [!] MQTT broker (Mosquitto) does not seem to be running on port 1883. Start it first.

REM A leftover node.exe from an earlier run (e.g. a terminal closed with the
REM X instead of Ctrl+C) can keep holding these ports and block this run
REM with an EADDRINUSE crash. Warn here instead of letting that surprise you.
netstat -ano | findstr ":3000 " | findstr LISTENING >nul
if not errorlevel 1 echo [!] Port 3000 is already in use - Lemon may already be running from an earlier session. If not, find and close it: netstat -ano ^| findstr :3000  then  taskkill /PID ^<the number^> /F
netstat -ano | findstr ":4000 " | findstr LISTENING >nul
if not errorlevel 1 echo [!] Port 4000 is already in use - Lemon may already be running from an earlier session. If not, find and close it: netstat -ano ^| findstr :4000  then  taskkill /PID ^<the number^> /F

echo.
echo Starting Lemon. Browser opens in a few seconds. Press Ctrl+C in this window to stop everything.
echo.
start "" /b cmd /c "timeout /t 6 /nobreak >nul && start http://localhost:3000/login"
echo real> ".limon-mode"
call npm run all
pause
