@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "APP_FILE=ai-proxy.js"
set "HOST=127.0.0.1"
set "PORT=8787"
set "LOG_FILE=%SCRIPT_DIR%ai-proxy.log"
set "ERR_FILE=%SCRIPT_DIR%ai-proxy.err.log"
set "PID_FILE=%SCRIPT_DIR%ai-proxy.pid"

cd /d "%SCRIPT_DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo [deploy] node was not found in PATH.
  exit /b 1
)

if not exist "%APP_FILE%" (
  echo [deploy] App file not found: %SCRIPT_DIR%%APP_FILE%
  exit /b 1
)

call "%SCRIPT_DIR%stop.cmd" >nul

echo [deploy] Starting server: node %APP_FILE%
start "CC MD MindMap" /D "%SCRIPT_DIR%" /min "%ComSpec%" /k node "%APP_FILE%" ^>^> "%LOG_FILE%" 2^>^> "%ERR_FILE%"

for /l %%I in (1,1,20) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = @(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); if ($p.Count -gt 0) { Set-Content -LiteralPath '%PID_FILE%' -Value ($p -join [Environment]::NewLine) -Encoding ASCII; exit 0 }; exit 1" >nul 2>nul
  if not errorlevel 1 goto started
  timeout /t 1 /nobreak >nul
)

echo [deploy] Server did not bind to port %PORT% in time. Check %LOG_FILE% and %ERR_FILE%
exit /b 1

:started
echo [deploy] Started. URL=http://%HOST%:%PORT%/
echo [deploy] Logs -^> %LOG_FILE%
exit /b 0
