// Opening a profile or lab page the model named, safely: https only, public hosts only, small and quick.
import https from "node:https";
import type { IncomingMessage } from "node:http";
import zlib from "node:zlib";
import { guardedLookup, hostnameAllowed } from "./ssrf.ts";

export interface PageResult {
  url: string;
  finalUrl: string;
  ok: boolean; // an HTML or text page was read
  status: number;
  html: string;
  reason?: string; // why it could not be read; for the server log only
}

const MAX_REDIRECTS = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; RareVerse-ContactCheck/1.0)";

// GET one page. Every hop (redirects included) must be https to a public host name, and its address is
// checked again when the connection is made (guardedLookup). The whole read is capped in time and bytes.
// Never throws: a page that cannot be read comes back with ok=false and a reason.
export async function fetchPage(url: string, opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }): Promise<PageResult> {
  const deadline = Date.now() + opts.timeoutMs;
  const fail = (finalUrl: string, reason: string, status = 0): PageResult => ({ url, finalUrl, ok: false, status, html: "", reason });
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let target: URL;
    try {
      target = new URL(current);
    } catch {
      return fail(current, "not a valid link");
    }
    if (target.protocol !== "https:") return fail(current, "not https");
    if (!hostnameAllowed(target.hostname)) return fail(current, "not a public host");
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail(current, "timed out");
    const answer = await getOnce(target, remaining, opts.maxBytes, opts.signal);
    if (answer.redirect) {
      try {
        current = new URL(answer.redirect, target).toString();
      } catch {
        return fail(target.toString(), "bad redirect", answer.status);
      }
      continue;
    }
    return { url, finalUrl: target.toString(), ok: answer.ok, status: answer.status, html: answer.html, reason: answer.reason };
  }
  return fail(current, "too many redirects");
}

interface Answer {
  status: number;
  ok: boolean;
  html: string;
  redirect?: string;
  reason?: string;
}

function decompress(res: IncomingMessage): NodeJS.ReadableStream {
  const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return res.pipe(zlib.createGunzip());
  if (encoding === "deflate") return res.pipe(zlib.createInflate());
  if (encoding === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function decodeBody(bytes: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function getOnce(target: URL, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<Answer> {
  return new Promise((resolve) => {
    let settled = false;
    const req = https.request(target, {
      method: "GET",
      lookup: guardedLookup,
      signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
        "accept-language": "en",
        "accept-encoding": "gzip, deflate, br",
      },
    });
    const timer = setTimeout(() => req.destroy(new Error("timed out")), timeoutMs);
    const settle = (answer: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
      req.destroy();
    };
    req.on("error", (error) => settle({ status: 0, ok: false, html: "", reason: error.message }));
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) return settle({ status, ok: false, html: "", redirect: location });
      if (status < 200 || status >= 300) return settle({ status, ok: false, html: "", reason: `HTTP ${status}` });
      const type = String(res.headers["content-type"] ?? "");
      if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(type)) return settle({ status, ok: false, html: "", reason: "not a web page" });
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = () => settle({ status, ok: true, html: decodeBody(Buffer.concat(chunks), type) });
      const body = decompress(res);
      body.on("data", (chunk: Buffer) => {
        if (settled) return;
        const room = maxBytes - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += chunk.length;
        if (size >= maxBytes) finish(); // the first megabyte is plenty to find a name
      });
      body.on("end", finish);
      body.on("error", (error: Error) => (chunks.length > 0 ? finish() : settle({ status, ok: false, html: "", reason: error.message })));
    });
    req.end();
  });
}
