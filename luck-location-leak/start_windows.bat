@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run setup_windows.bat first.
  pause
  exit /b 1
)
set "PORT=8080"
if not "%~1"=="" set "PORT=%~1"
echo Starting the dashboard at http://localhost:%PORT%  (press Ctrl+C in this window to stop)
start "" "http://localhost:%PORT%"
".venv\Scripts\python.exe" -m uvicorn server.app:app --port %PORT%
pause
