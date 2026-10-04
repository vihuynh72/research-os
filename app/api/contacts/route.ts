// POST /api/contacts { diseaseIds: [1–2 Disease ids] } → who to contact about the disease(s), found by OpenAI
// with web search and checked by lib/contacts. Plain JSON by default; with `Accept: application/x-ndjson`
// it streams one progress line per step and then the same body, so the dialog can show real progress.
import { clientKey, createTtlCache, type TtlCache } from "@/lib/contacts/limits";
import { hasOpenAiKey, liveDeps } from "@/lib/contacts/live";
import { modelName } from "@/lib/contacts/openai";
import { CACHE_ENTRIES, CACHE_TTL_MS, createContactFinder, errorBody, statusFor } from "@/lib/contacts/service";
import type { ContactsBody, ContactsLine, ContactsResult } from "@/lib/contacts/types";
import { loadAtlasData } from "@/lib/data/source";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 4096;

// A whole number from the environment within [min, max], else the fallback.
function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

// How many proxies in front of this server append to X-Forwarded-For (0: none is trusted). See clientKey.
const TRUSTED_PROXY_HOPS = envInt("CONTACTS_TRUSTED_PROXY_HOPS", 0, 0, 5);

// `next dev` reloads this module on every save. Keeping answers on globalThis means a save does not make the
// next click pay for another OpenAI call; in production the module loads once anyway.
const memory = globalThis as typeof globalThis & { __rareverseContactAnswers?: TtlCache<ContactsResult> };
memory.__rareverseContactAnswers ??= createTtlCache<ContactsResult>(CACHE_TTL_MS, CACHE_ENTRIES);

const finder = createContactFinder({
  deps: liveDeps(),
  model: () => modelName(process.env.OPENAI_MODEL),
  hasKey: hasOpenAiKey,
  cache: memory.__rareverseContactAnswers,
  hourlyLimit: envInt("CONTACTS_MAX_SEARCHES_PER_HOUR", 30, 1, 1000),
});

function json(body: ContactsBody): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  const retryAfter = "error" in body ? body.error.retry_after_sec : undefined;
  if (retryAfter) headers["retry-after"] = String(retryAfter);
  return Response.json(body, { status: statusFor(body), headers });
}

async function readDiseaseIds(request: Request): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as { diseaseIds?: unknown }).diseaseIds : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const data = loadAtlasData();
    if (!data.ok) return json(errorBody("upstream_failed", "The RareVerse data is not available right now."));
    const client = clientKey(request.headers.get("x-forwarded-for"), TRUSTED_PROXY_HOPS);
    const started = finder.start({ graph: data.data.graph, diseaseIds: await readDiseaseIds(request), client });
    if (started.kind === "answer") return json(started.body);
    if (!(request.headers.get("accept") ?? "").includes("application/x-ndjson")) return json(await started.result);

    const encoder = new TextEncoder();
    let stopListening = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (line: ContactsLine) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            // the reader has gone; the search still finishes and is cached
          }
        };
        stopListening = started.listen(send);
        void started.result.then((body) => {
          stopListening();
          send({ type: "done", body });
          try {
            controller.close();
          } catch {
            // already closed by the reader
          }
        });
      },
      cancel() {
        stopListening();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  } catch (error) {
    // Never a stack trace to the browser; the server log gets the message only.
    console.error(`[contacts] request failed: ${(error as Error)?.message}`);
    return json(errorBody("upstream_failed"));
  }
}
