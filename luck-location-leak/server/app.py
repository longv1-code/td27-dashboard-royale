"""
Pit Boss server: serves the static dashboard and adds optional, sponsor-backed APIs.

Every integration is optional. With no environment variables set, the server just
serves the dashboard and the page falls back to its offline behaviour.

  GEMINI_API_KEY        -> /api/ask answered by Google Gemini (Best Use of Gemini API)
  MONGODB_URI           -> Q&A log, floor-manager notes and plan snapshots in MongoDB Atlas
  TIMESCALE_URL         -> /api/hourly served from a Tiger Data (TimescaleDB) hypertable

Keys can live in a .env file at the project root (see .env.example); it is read at startup.

Run:  uvicorn server.app:app --host 0.0.0.0 --port 8080
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"


def _load_dotenv(path: Path) -> None:
    """Minimal .env reader (KEY=value lines); real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if v:
            os.environ.setdefault(k.strip(), v)


_load_dotenv(ROOT / ".env")
app = FastAPI(title="Luck, Location, or Leak? — Pit Boss API")


@app.middleware("http")
async def no_stale_assets(request, call_next):
    resp = await call_next(request)
    if request.url.path.endswith((".js", ".html", ".json")) or request.url.path == "/":
        resp.headers["Cache-Control"] = "no-cache"
    return resp

LLM_ON = bool(os.getenv("GEMINI_API_KEY"))
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

SYSTEM = (
    "You are the Pit Boss, an analyst for The Gilded Ace, a FICTIONAL casino with synthetic data. "
    "Answer the floor manager's question in at most 120 words using ONLY the claims and machine tests provided. "
    "Cite claim ids like C3. If the evidence does not answer it, say so. "
    "Never accuse anyone: unusual payouts are leads to inspect, not proof of wrongdoing. "
    "Never suggest marketing to heavy losers. Return JSON: {\"answer\": string, \"cites\": [claim ids]}."
)

# ---------------------------------------------------------------- MongoDB Atlas (optional)
_mongo = None


def mongo():
    global _mongo
    if _mongo is None and os.getenv("MONGODB_URI"):
        from pymongo import MongoClient
        _mongo = MongoClient(os.environ["MONGODB_URI"], appname="gilded-ace-pitboss")[os.getenv("MONGODB_DB", "gilded_ace")]
        _mongo.notes.create_index([("machine_id", 1), ("created_at", -1)])
        _mongo.pitboss_log.create_index([("created_at", -1)])
    return _mongo


# ---------------------------------------------------------------- Gemini
async def ask_gemini(prompt: str) -> dict:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json",
                             "responseSchema": {"type": "OBJECT", "properties": {"answer": {"type": "STRING"}, "cites": {"type": "ARRAY", "items": {"type": "STRING"}}}, "required": ["answer"]}},
    }
    async with httpx.AsyncClient(timeout=25) as cx:
        r = await cx.post(url, json=body, headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    r.raise_for_status()
    text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)


@app.get("/api/health")
def health():
    return {"llm": f"Gemini ({GEMINI_MODEL})" if LLM_ON else None,
            "mongo": bool(os.getenv("MONGODB_URI")), "timescale": bool(os.getenv("TIMESCALE_URL"))}


@app.post("/api/ask")
async def ask(req: Request):
    body = await req.json()
    q = str(body.get("question", ""))[:500]
    ctx = body.get("context", {})
    if not LLM_ON:
        raise HTTPException(503, "Gemini not configured")
    prompt = f"QUESTION: {q}\n\nEVIDENCE (claims table): {json.dumps(ctx.get('claims', []))}\n\nMACHINE TESTS: {json.dumps(ctx.get('machine'))}\n\nPERIOD ON SCREEN: {ctx.get('period')}"
    t = time.time()
    out = await ask_gemini(prompt)
    valid = {c["id"] for c in ctx.get("claims", [])}
    out["cites"] = [c for c in out.get("cites", []) if c in valid]  # never show a citation the page cannot trace
    out["provider"] = health()["llm"]
    db = mongo()
    if db is not None:
        db.pitboss_log.insert_one({"question": q, "answer": out["answer"], "cites": out["cites"], "provider": out["provider"],
                                   "latency_ms": int((time.time() - t) * 1000), "created_at": datetime.now(timezone.utc)})
    return out


# ---------------------------------------------------------------- notes & plan snapshots (MongoDB)
@app.get("/api/notes")
def list_notes(machine_id: str | None = None):
    db = mongo()
    if db is None:
        raise HTTPException(503, "MongoDB not configured")
    f = {"machine_id": machine_id} if machine_id else {}
    return [{**n, "_id": str(n["_id"]), "created_at": n["created_at"].isoformat()} for n in db.notes.find(f).sort("created_at", -1).limit(100)]


@app.post("/api/notes")
async def add_note(req: Request):
    db = mongo()
    if db is None:
        raise HTTPException(503, "MongoDB not configured")
    b = await req.json()
    doc = {"machine_id": str(b.get("machine_id", ""))[:12], "author": str(b.get("author", "floor"))[:40], "text": str(b.get("text", ""))[:2000],
           "status": b.get("status", "open"), "created_at": datetime.now(timezone.utc)}
    db.notes.insert_one(doc)
    return {"ok": True}


@app.post("/api/plan")
async def save_plan(req: Request):
    """Store a plan snapshot in MongoDB, keyed by its SHA-256 so identical plans are stored once."""
    plan = await req.json()
    canon = json.dumps(plan, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canon.encode()).hexdigest()
    db = mongo()
    if db is not None:
        db.plans.update_one({"sha256": digest}, {"$setOnInsert": {"plan": plan, "sha256": digest, "created_at": datetime.now(timezone.utc)}}, upsert=True)
    return {"sha256": digest, "stored": db is not None}


# ---------------------------------------------------------------- hourly drill-down (Tiger Data / TimescaleDB)
@app.get("/api/hourly")
def hourly(machine_id: str, start: str = "2025-01-01", end: str = "2025-07-01"):
    if not os.getenv("TIMESCALE_URL"):
        raise HTTPException(503, "Tiger Data not configured")
    if not re.fullmatch(r"M-\d{4}", machine_id):
        raise HTTPException(400, "bad machine id")
    import psycopg
    with psycopg.connect(os.environ["TIMESCALE_URL"]) as con:
        rows = con.execute("""
            SELECT bucket, coin_in_usd, down_hours, hit_rate
            FROM machine_daily_cagg WHERE machine_id = %s AND bucket >= %s AND bucket < %s ORDER BY bucket""",
                           (machine_id, start, end)).fetchall()
    return [{"day": r[0].isoformat(), "coin_in": float(r[1] or 0), "down_h": float(r[2] or 0), "hit_rate": float(r[3]) if r[3] is not None else None} for r in rows]


# ---------------------------------------------------------------- static dashboard
@app.get("/", response_class=HTMLResponse)
def index():
    page = (WEB / "index.html").read_text(encoding="utf-8")
    return ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"></head><body>" + page + "</body></html>")


app.mount("/", StaticFiles(directory=WEB), name="web")


@app.exception_handler(httpx.HTTPError)
async def upstream_error(_, exc):
    return JSONResponse({"error": "LLM provider error", "detail": str(exc)[:200]}, status_code=502)
