---
name: GitHub push auth
description: How pushing to origin (vihuynh72/research-os) can and cannot authenticate from this Replit workspace.
---

- Shell `git push` uses `replit-git-askpass`, which shares credentials with the Git pane. When those are missing or expired, GitHub answers "Invalid username or token". Per Replit docs, the fix is for the user to connect or re-authenticate GitHub in the workspace (Git pane, or account Connected services). Public fetch/ls-remote always work.
- The "GitHub (App)" integration authenticates as vihuynh72 through an API proxy only (no raw token to hand to git). It had NO app installation on the account, so every API write (blobs, contents) returned 403 "Resource not accessible by integration"; reads of the public repo and Actions runs work.
- If API writes ever become possible: commits can be replayed through the Git Data API with identical SHAs (same blobs/trees, exact message bytes, explicit author/committer with UTC dates), then fast-forward `heads/main`. Local and remote then stay in sync.

**Why:** found 2026-10-03 while making origin the team's source of truth; cost several attempts.

**How to apply:** connector authorization and shell Git authentication are separate. Do not repeat pushes with a rejected credential expecting it to refresh. If Git-pane reauthentication fails, Replit documents GitHub CLI browser authorization as an alternative; the user must approve it before the CLI can authenticate Git pushes. Never print or store tokens in project files. Pushing `.github/workflows/*` also needs workflow permission on whatever credential is used.
