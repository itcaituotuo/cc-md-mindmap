@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PORT=8787"
set "PID_FILE=%SCRIPT_DIR%ai-proxy.pid"
set "PIDS="

for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  call set "PIDS=%%PIDS%% %%P"
)

if "%PIDS%"=="" if exist "%PID_FILE%" (
  for /f "usebackq delims=" %%P in ("%PID_FILE%") do (
    tasklist /fi "PID eq %%P" 2>nul | findstr /R /C:"[ ]%%P[ ]" >nul
    if not errorlevel 1 call set "PIDS=%%PIDS%% %%P"
  )
)

if "%PIDS%"=="" (
  echo [stop] No running server on port %PORT%.
  if exist "%PID_FILE%" del /f /q "%PID_FILE%" >nul 2>nul
  exit /b 0
)

echo [stop] Stopping server (PID:%PIDS% )...
for %%P in (%PIDS%) do (
  taskkill /pid %%P /t /f >nul 2>nul
)

if exist "%PID_FILE%" del /f /q "%PID_FILE%" >nul 2>nul
echo [stop] Stopped.
exit /b 0
