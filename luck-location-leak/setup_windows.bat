@echo off
setlocal
cd /d "%~dp0"
echo === Luck, Location, or Leak? : Windows setup ===

set "PY=python"
where py >nul 2>nul && set "PY=py -3"
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 (
  echo Python 3.11 or newer was not found.
  echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH", then run this again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment in .venv ...
  %PY% -m venv .venv || (echo Could not create .venv & pause & exit /b 1)
)

echo Installing packages (first run takes a few minutes) ...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt || (echo Package install failed. & pause & exit /b 1)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created .env from .env.example. Open it in Notepad and paste your keys; blank keys just turn that feature off.
)

echo.
echo Setup complete. Double-click start_windows.bat to open the dashboard.
pause
