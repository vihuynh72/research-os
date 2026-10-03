---
name: Development workflow ownership
description: Failed workflow state can coexist with a live older server during workspace transitions.
---

Do not equate a failed workflow with an unused application port.

**Why:** repeated workspace workflow transitions left an earlier npm/Next.js process serving port 5000 while replacement workflows failed with EADDRINUSE. The active server could still return application errors independently of the failed startup.

**How to apply:** inspect both workflow output and the server response. Identify the process and its working directory before stopping any leftover server; never kill unrelated port owners. Prefer launching the framework directly in the foreground so shutdown signals reach its own child-process cleanup.

Allow the exact proxied development hostname as well as local screenshot origins when configuring development access.

**Why:** a wildcard development-domain entry alone did not permit a nested Replit hostname; Next.js blocked hot reload, and the client-only 3D view remained in its loading state. Explicit host allowance restored both.

**How to apply:** distinguish a successful HTML response from a hydrated, functioning client view. Check browser logs for blocked development-origin requests before changing working component logic.