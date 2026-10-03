---
name: GitHub push auth
description: How pushing to origin (vihuynh72/research-os) authenticates from this Replit workspace.
---

`git push` with the workspace's default `replit-git-askpass` fails ("Invalid username or token") — the Replit account has no working GitHub credential for this repo. Public reads (fetch, ls-remote) work without auth.

**Why:** discovered on 2026-10-03 while setting up origin as the team's source of truth.

**How to apply:** pushes need the GitHub integration authorized by the user; never print or store the token. Pushing `.github/workflows/*` may additionally need the `workflows` permission on that token.
