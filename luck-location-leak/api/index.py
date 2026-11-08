"""Vercel entry point: exposes the FastAPI app from server/app.py as one serverless function.
vercel.json rewrites every /api/* request here; the dashboard itself is served as static files from web/."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app import app  # noqa: E402,F401  (Vercel looks for a module-level `app`)
