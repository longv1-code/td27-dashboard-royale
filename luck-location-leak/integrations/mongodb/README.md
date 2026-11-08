# MongoDB Atlas: the floor manager's decision log

The dashboard is the analysis; Atlas is where the casino's people act on it.

| Collection | Written by | Why it is a document store |
| --- | --- | --- |
| `pitboss_log` | `POST /api/ask` | Every question, answer, cited claim ids, LLM provider and latency. Lets us audit what the AI told managers. |
| `notes` | `POST /api/notes` | Free-form inspection notes per machine (`M-1158: tech found paytable chip v2.1 instead of v1.4`). Shape varies by author. |
| `plans` | `POST /api/plan` | Snapshot of the $100k plan the GM approved, keyed by its SHA-256, so the plan judges see can be matched to the one approved. |

## Setup (free M0 cluster)

1. Create an Atlas M0 cluster and a database user; under Network Access allow your IP (and later the Vultr instance IP).
2. Put the connection string in `.env`: `MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/?retryWrites=true&w=majority`
3. Restart the server. Indexes are created on first use.

## Useful queries (Atlas Data Explorer / mongosh)

```js
// Which questions do managers ask most, and does the AI cite evidence?
db.pitboss_log.aggregate([
  { $group: { _id: { $toLower: "$question" }, n: { $sum: 1 }, cited: { $avg: { $size: "$cites" } } } },
  { $sort: { n: -1 } }, { $limit: 10 }
])

// Open inspection notes by machine
db.notes.find({ status: "open" }).sort({ created_at: -1 })
```
