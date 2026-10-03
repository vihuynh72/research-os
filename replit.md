# CVI Atlas (research-os)

Hack-Nation 2026, Challenge 05 (OpenAI x Buffalo Initiative). The team plan, owners, clock and rules live in `PLAN-16H.md`.

## Stack and running
- Next.js 16 (App Router) + TypeScript + Tailwind CSS v4, one package at the repo root.
- Dev: `npm run dev` (Replit workflow "Start application", port 5000).
- Production: Replit Autoscale, build `npm run build`, run `npm run start`. Publishing happens from the Replit workspace (Publish button); a push to GitHub does not redeploy by itself.

## Data contract
- `schema.json` (JSON Schema 2020-12) is the contract for graph.json. It is a draft (0.1.0) and changes only with Vi, Jaspaal and Paul agreeing.
- `npm run check:schema` validates the schema, its embedded example, and `public/graph.json` when present, plus unique ids and that every edge points at existing nodes. Pass other files as arguments to check them.

## Git and CI
- origin: https://github.com/vihuynh72/research-os, branch `main`. Pull before push.
- GitHub Actions (`.github/workflows/ci.yml`) on pushes to main and on PRs: npm ci, check:schema, build, typecheck.

## Lanes (from PLAN-16H.md)
- Vi: the app and infra (this Replit, UI, routes, deployment).
- Jaspaal: data pipeline, graph.json and clusters.json, OpenAI extraction, /api/explain.
- Paul: data/community.csv, evidence QA, README narrative, demo and submission.
- `OPENAI_API_KEY` goes in Replit Secrets and is used only in `app/api/*` route handlers, never in the browser.
