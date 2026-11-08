# Appendix B — AI-use disclosure

| Tool | Used for | Not used for |
|---|---|---|
| Claude (Anthropic), via Claude Code | Exploring the tables with DuckDB queries; writing `pipeline/build.py`, the dashboard (`web/`), the FastAPI server and integration scripts; drafting this write-up, the appendix and the DEV post | Producing any number. Every figure comes from code in this repo run against the release files, and we checked the key results (M-1158 hit-rate test, closure diff-in-diff, comp-rate step, model MAE) by re-running queries |
| Google Gemini API (at runtime) | "Ask the Pit Boss": answers a manager's question using only the dashboard's claims table, returns cited claim ids; uncited ids are stripped server-side | Analysis, data, or recommendations |

Guardrails in the Pit Boss prompt: fictional casino only; cite claims; unusual payouts are leads to inspect, not proof of wrongdoing; never suggest marketing to heavy losers. Every Q&A is logged to MongoDB Atlas (`pitboss_log`) for audit when configured.
