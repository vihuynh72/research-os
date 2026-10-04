// In-memory guards for the contact finder: a small cache, so a repeated question costs nothing, and rate
// limits, so no one can run up the OpenAI bill. Per server process, by design.

export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
}

export function createTtlCache<V>(ttlMs: number, maxEntries: number, now: () => number = Date.now): TtlCache<V> {
  const entries = new Map<string, { value: V; expires: number }>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttlMs });
      // Maps keep insertion order, so the first key is the oldest.
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    },
  };
}

export type Turn = { ok: true } | { ok: false; retryAfterSec: number };

export interface RateLimiter {
  // Whether the key may be used now, without counting a use; when not, how many seconds until it may.
  check(key: string): Turn;
  // The same, and a use is counted when allowed.
  take(key: string): Turn;
}

export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now, maxKeys = 5000): RateLimiter {
  const uses = new Map<string, number[]>();
  // The uses still inside the window (oldest first), and whether one more fits.
  const look = (key: string) => {
    const t = now();
    const used = (uses.get(key) ?? []).filter((at) => at > t - windowMs);
    const turn: Turn = used.length < limit ? { ok: true } : { ok: false, retryAfterSec: Math.max(1, Math.ceil((used[used.length - limit] + windowMs - t) / 1000)) };
    return { t, used, turn };
  };
  return {
    check: (key) => look(key).turn,
    take(key) {
      const { t, used, turn } = look(key);
      if (!turn.ok) return turn;
      used.push(t);
      uses.delete(key);
      uses.set(key, used);
      while (uses.size > maxKeys) uses.delete(uses.keys().next().value!);
      return turn;
    },
  };
}

// The key every request shares when the client cannot be told apart.
export const SHARED_CLIENT = "everyone";

// Who is asking, for the per-client limit. Anyone can send an X-Forwarded-For header, and Next.js fills it
// from the socket only when a request has none (a route handler sees no socket address), so the header names
// the client only through proxies the server is told to trust: each appends the address it saw, so with
// `trustedHops` of them in front the client is that many entries from the right. Without a trusted proxy,
// or with a header shorter than the proxies would make it, every request counts against one shared key.
// The hourly cap on new searches guards the bill whatever the headers say.
export function clientKey(forwardedFor: string | null, trustedHops: number): string {
  if (!Number.isInteger(trustedHops) || trustedHops < 1) return SHARED_CLIENT;
  const hops = (forwardedFor ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.length >= trustedHops ? `ip:${hops[hops.length - trustedHops]}` : SHARED_CLIENT;
}
