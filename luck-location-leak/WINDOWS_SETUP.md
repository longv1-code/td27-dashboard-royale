# Windows setup

Tested on Windows 11 with Python 3.11. You need about 500 MB of disk for the Python packages.

## 1. Install Python (once)

1. Download Python 3.11 or newer from https://www.python.org/downloads/.
2. In the installer, tick **Add python.exe to PATH**, then click **Install Now**.

## 2. Unzip the project

Right-click `luck-location-leak.zip` → **Extract All…** and pick a folder you will keep, for example `Documents\luck-location-leak`. Avoid running it from inside the zip.

## 3. Run setup (once)

Double-click **`setup_windows.bat`**. It:

- creates a private Python environment in `.venv`
- installs the packages from `requirements.txt`
- copies `.env.example` to `.env` if you don't have one yet

## 4. Add your keys (optional)

Open `.env` in Notepad (right-click → **Open with** → Notepad) and paste your keys after the `=` signs, without quotes:

```
GEMINI_API_KEY=your-key-here
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority
TIMESCALE_URL=postgres://tsdbadmin:password@host.tsdb.cloud.timescale.com:12345/tsdb?sslmode=require
```

Every key is optional. With no keys the full dashboard still works, and "Ask the Pit Boss" answers by searching the evidence table offline. `.env` stays on your computer: it is listed in `.gitignore`, and the Docker image never copies it. Don't email it or commit it.

## 5. Start the dashboard

Double-click **`start_windows.bat`**. Your browser opens http://localhost:8080. Keep the black window open while you use it; close it (or press Ctrl+C) to stop.

If port 8080 is busy, open PowerShell in the project folder and run `.\start_windows.bat 8090`.

## Same steps in PowerShell (if you prefer)

```powershell
cd $HOME\Documents\luck-location-leak
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env        # then edit .env in Notepad
.\.venv\Scripts\python.exe -m uvicorn server.app:app --port 8080
```

If PowerShell refuses to run `Activate.ps1`, you don't need it: the commands above call `.venv\Scripts\python.exe` directly.

## Optional: rebuild the data from the challenge release

The zip already contains the processed data (`web/data/data.json`), so this is only needed if you change the analysis. Download the Dashboard Royale release (https://github.com/tamu-datathon-org/dashboard-royale), unzip it, then:

```powershell
.\.venv\Scripts\python.exe pipeline\build.py --data C:\path\to\dashboard-royale\data
```

## Optional: load Tiger Data (TimescaleDB)

After `TIMESCALE_URL` is in `.env` (no `psql` needed):

```powershell
.\.venv\Scripts\python.exe integrations\timescale\load.py --data C:\path\to\dashboard-royale\data
```

It creates the hypertable and continuous aggregate, loads 1.3M machine-hours, and prints the first-day payout-fingerprint alert (it should list M-1158).

## Check that the keys work

With the server running, open http://localhost:8080/api/health. You should see your services marked as on, for example:

```json
{"llm": "Gemini (gemini-2.5-flash)", "mongo": true, "timescale": true}
```

## Troubleshooting

| Problem | Fix |
|---|---|
| "Python 3.11 or newer was not found" | Reinstall Python with **Add python.exe to PATH** ticked, then reopen the folder. |
| Page shows "Shuffling 56,110 machine-days…" for a long time | The first load reads a 4 MB data file; wait a few seconds. If it never loads, make sure you started the server rather than opening `index.html` directly. |
| Pit Boss says "offline keyword match" | `GEMINI_API_KEY` is empty or wrong in `.env`. Fix it and restart `start_windows.bat`. |
| MongoDB errors | In Atlas, add your IP under **Network Access** and check the user's password in the connection string. |
| Windows SmartScreen warns about the `.bat` files | They are plain text; right-click → **Edit** to read them before running. |
