# Sponsor tracks we are entering

| Track | What it does in the project | Code | Your setup step |
|---|---|---|---|
| **Best Use of Gemini API** | "Ask the Pit Boss": Gemini answers a manager's question using only the dashboard's claims table, returns JSON `{answer, cites}` (enforced with `responseSchema`), and the server drops any citation the page can't trace. Answers render with "Show C3" buttons that jump to the evidence chart. | `server/app.py` → `/api/ask` | Create a key at aistudio.google.com and put it in `.env` as `GEMINI_API_KEY`. |
| **Best Use of MongoDB Atlas** | Decision log: `pitboss_log` (an audit trail of every AI answer), `notes` (inspection notes per machine) and `plans` (approved $100k plan snapshots keyed by SHA-256). | `server/app.py`, `integrations/mongodb/README.md` | Create a free M0 cluster and a database user, allow network access, and put the `mongodb+srv://…` string in `.env` as `MONGODB_URI`. |
| **Best Use of Tiger Data** | `machine_hour` (1.3M rows) as a TimescaleDB hypertable with compression, a continuous aggregate behind `/api/hourly`, and `payout_fingerprint()`: one SQL call that flags M-1158 from its first day of data. | `integrations/timescale/schema.sql`, `load.py` | Create a Tiger Cloud service, put its connection string in `.env` as `TIMESCALE_URL`, then run `python integrations/timescale/load.py --data <release>/data` (creates the schema too; no psql needed). |
| **Best Use of Vultr** | Hosts the public dashboard and the API, which keeps the Gemini key off the browser, behind HTTPS. | `deploy/Dockerfile`, `deploy/VULTR.md` | Create an Ubuntu instance and follow `VULTR.md`. Pass the same `.env` to `docker run --env-file .env`. |
| **Best Domain Name from GoDaddy Registry** | The public URL judges open. | `deploy/VULTR.md` (Caddy config) | Register the domain and add an A record pointing at the Vultr IP. |
| **DEV Writing Challenge** | "Hold tells you in six months. Hit rate tells you on day one." | `docs/DEV_POST.md` | Publish it on dev.to with the hackathon tag and link it on Devpost. |

Before you claim each track, test it with the real service and take a screenshot for Devpost: a cited Pit Boss answer, the Atlas collections, and the Tiger Data day-one alert output.
