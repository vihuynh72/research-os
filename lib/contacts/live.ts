// The contact finder's real network clients. Server only: this is where the OpenAI key is read, from
// process.env at call time; it is sent to api.openai.com and nowhere else, and never logged. The import
// below makes any client component that reaches this file fail the build instead of shipping it.
import "server-only";
import { callResponses } from "./openai.ts";
import { fetchPage } from "./page.ts";
import { fetchPapers } from "./pubmed.ts";
import { fetchGrants } from "./reporter.ts";
import type { ContactDeps } from "./service.ts";

const PAGE_TIMEOUT_MS = 6_000;
const PAGE_MAX_BYTES = 1_000_000;

export function hasOpenAiKey(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

export function liveDeps(): ContactDeps {
  return {
    fetchPapers: (pmids, signal) => fetchPapers(pmids, signal, { NCBI_TOOL: process.env.NCBI_TOOL, NCBI_EMAIL: process.env.NCBI_EMAIL }),
    fetchGrants,
    askModel: (request, signal) => callResponses(request, process.env.OPENAI_API_KEY?.trim() ?? "", signal),
    fetchPage: (url, signal) => fetchPage(url, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES, signal }),
    log: (message) => console.info(`[contacts] ${message}`),
  };
}
