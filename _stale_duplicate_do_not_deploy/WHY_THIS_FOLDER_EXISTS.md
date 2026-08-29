# Why these files are here

These six files (`README.md`, `aiNarrative.js`, `db.js`, `emailTemplates.js`, `package.json`, `server.js`) used to sit at the repo root. They're an older, stale copy of the backend -- Render has always actually built and run the code in `../frankly-inspired-backend 2/` (see that service's build/start commands in the Render dashboard: `cd "frankly-inspired-backend 2" && npm install` / `npm start`). These root-level files stopped being deployed at some point but were never removed, so the repo looked like it had two live backends.

Moved here on 2026-08-29 rather than deleted, since file deletion isn't available in this environment right now. Safe to delete this whole folder whenever convenient -- nothing in the deployed app depends on it.
