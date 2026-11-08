# MongoDB Atlas: the floor's memory

The dashboard is the analysis; Atlas is where the casino's people act on it, and where the Pit Boss looks up what they found.

| Collection | Written by | What it holds |
| --- | --- | --- |
| `notes` | `POST /api/notes` (case file → Floor notes) | Technician notes per machine, `status`, `priority`, `source` (`human` or `gemini-draft`), and a 768-d Gemini embedding. Searched with Atlas Vector Search. |
| `pitboss_log` | `POST /api/ask`, `POST /api/feedback` | Every question and answer: citations, machines, confidence, notes retrieved, latency, Gemini token usage, and the manager's helpful / not-helpful vote. |
| `plans` | `POST /api/plan` (Plan tab → Lock in this plan) | The exact $100k plan, keyed by SHA-256 of its canonical JSON, with a `locks` counter. |

## How retrieval works

1. A note is saved → the server embeds `"M-1158: <text>"` with `gemini-embedding-001` (`RETRIEVAL_DOCUMENT`, 768 dims, L2-normalised) and stores it on the document.
2. A question arrives → it is embedded (`RETRIEVAL_QUERY`) and run through `$vectorSearch` on index `notes_vec`. Notes for any machine named in the question are added too.
3. The matching notes go to Gemini next to the claims table, each with an id like `N-1a2b3c`. Gemini may cite them; the server keeps only ids it actually sent.

If the vector index isn't available yet (still building, or not an Atlas cluster), the server falls back to cosine similarity in Python over the 400 newest notes. `/api/insights` reports which path is active.

## Setup (free M0 cluster)

1. Create an Atlas M0 cluster and a database user; under Network Access allow your IP (and later the Vultr instance IP).
2. Put the connection string in `.env`: `MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/?retryWrites=true&w=majority`
3. `pip install -r requirements.txt` (needs `pymongo>=4.7`), then restart the server. Indexes, including the `notes_vec` vector index, are created on first use; give the vector index about a minute.

The index the server creates:

```json
{ "fields": [
  { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
  { "type": "filter", "path": "machine_id" },
  { "type": "filter", "path": "status" }
] }
```

## Useful queries (Atlas Data Explorer / mongosh)

```js
// Which evidence does the AI lean on, and do managers find the answers useful?
db.pitboss_log.aggregate([
  { $unwind: "$cites" },
  { $group: { _id: "$cites", n: { $sum: 1 }, helpful: { $avg: { $cond: [{ $eq: ["$vote", 1] }, 1, 0] } } } },
  { $sort: { n: -1 } }, { $limit: 10 }
])

// Open inspection notes, newest first
db.notes.find({ status: "open" }, { embedding: 0 }).sort({ created_at: -1 })
```
