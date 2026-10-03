---
name: npm registry portability
description: Why dependency installation can pass on Replit but fail on external CI.
---

Treat lockfile registry portability as a requirement whenever dependencies are refreshed on Replit.

**Why:** Replit installations can record private package-firewall tarball URLs. External GitHub runners cannot resolve that hostname, even though the packages install correctly inside Replit.

**How to apply:** keep Replit's package firewall enabled locally. Ensure external CI can obtain the same pinned packages from an accessible registry without changing versions or integrity hashes. Diagnose DNS failures separately from dependency or application failures.