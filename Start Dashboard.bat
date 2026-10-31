@echo off
title NASA Adapting Farms
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Can chai dat Node.js truoc: https://nodejs.org  ^(chon ban LTS^), roi mo lai file nay.
  echo Hoac nhap dup file index.html de xem ban demo khong can cai gi.
  start https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing for the first time, please wait...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Install failed. Please send a screenshot of this window.
    pause
    exit /b 1
  )
)
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5173/"
node server\server.mjs
pause
