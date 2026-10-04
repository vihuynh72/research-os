import test from "node:test";
import assert from "node:assert/strict";
import { SHARED_CLIENT, clientKey, createRateLimiter, createTtlCache } from "./limits.ts";

test("cached answers expire on time, and the oldest go first when the cache is full", () => {
  let t = 0;
  const cache = createTtlCache<string>(1000, 2, () => t);
  cache.set("a", "A");
  t = 999;
  assert.equal(cache.get("a"), "A");
  t = 1000;
  assert.equal(cache.get("a"), undefined);
  cache.set("b", "B");
  cache.set("c", "C");
  cache.set("d", "D");
  assert.deepEqual([cache.get("b"), cache.get("c"), cache.get("d")], [undefined, "C", "D"]);
});

test("each client gets a fixed number of uses per window, and is told how long to wait", () => {
  let t = 0;
  const limiter = createRateLimiter(2, 60_000, () => t);
  assert.deepEqual(limiter.take("ip-1"), { ok: true });
  t = 10_000;
  assert.deepEqual(limiter.take("ip-1"), { ok: true });
  assert.deepEqual(limiter.take("ip-1"), { ok: false, retryAfterSec: 50 });
  assert.deepEqual(limiter.take("ip-2"), { ok: true }, "another client has its own count");
  t = 60_001;
  assert.deepEqual(limiter.take("ip-1"), { ok: true }, "the first use has left the window");
});

test("checking a key counts nothing; only take does", () => {
  const limiter = createRateLimiter(1, 60_000, () => 0);
  for (let i = 0; i < 5; i++) assert.deepEqual(limiter.check("k"), { ok: true });
  assert.deepEqual(limiter.take("k"), { ok: true });
  assert.deepEqual(limiter.check("k"), { ok: false, retryAfterSec: 60 });
  assert.deepEqual(limiter.take("k"), { ok: false, retryAfterSec: 60 }, "a refused take counts nothing either");
});

test("X-Forwarded-For names the client only through the proxies the server trusts", () => {
  // No trusted proxy: anyone can write the header (Next keeps a client's own value), so all share one key.
  assert.equal(clientKey("203.0.113.9", 0), SHARED_CLIENT);
  assert.equal(clientKey(`${Math.random()}`, 0), SHARED_CLIENT, "a made-up value buys no fresh limit");
  assert.equal(clientKey(null, 0), SHARED_CLIENT);
  // One trusted proxy appends the address it saw: the right-most entry, whatever the client put before it.
  assert.equal(clientKey("1.1.1.1, 2.2.2.2, 198.51.100.7", 1), "ip:198.51.100.7");
  assert.equal(clientKey("198.51.100.7", 1), "ip:198.51.100.7");
  // Two trusted proxies (a load balancer behind a CDN): the second entry from the right.
  assert.equal(clientKey("spoofed, 198.51.100.7, 10.0.0.2", 2), "ip:198.51.100.7");
  // Fewer entries than the proxies would make: the request did not come through them.
  assert.equal(clientKey("198.51.100.7", 2), SHARED_CLIENT);
  assert.equal(clientKey(" , ", 1), SHARED_CLIENT);
  assert.equal(clientKey("198.51.100.7", 1.5), SHARED_CLIENT);
});
