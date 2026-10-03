---
name: One lane per teammate
description: Scope rule for this hackathon repo — work only in the lane (PLAN-16H.md) of the teammate you are working for.
---

Team: Vi (app + infra), Jaspaal (data + AI), Paul (community data, QA, story). This repl's owner is Vi, who said: "let's start on with my part, don't overlap into the task of my team member."

**Why:** three people (plus Claude Code / Codex) push to the same GitHub main; overlapping work causes merge conflicts and duplicated effort.

**How to apply:** for Vi, do NOT build Jaspaal's pipeline / mock graph / OpenAI extraction / explain logic, or Paul's community.csv / README narrative / demo. If a task needs another lane's output (graph.json, /api/explain), stub against schema.json and say so. schema.json changes need all three to agree — propose, don't impose.
