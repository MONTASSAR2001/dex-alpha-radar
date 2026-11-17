import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunk, mapLimit, TokenBucket, TtlCache } from "../../mcp-server/src/limiter.js";
import { fakeTime } from "../helpers.js";

describe("TokenBucket pacing", () => {
  it("allows a burst up to capacity, then paces at the refill rate", async () => {
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 2, refillPerMinute: 60, now: clock.now, sleep: clock.sleep });
    const start = clock.now();
    const stamps: number[] = [];
    for (let i = 0; i < 5; i++) {
      await bucket.acquire();
      stamps.push(clock.now() - start);
    }
    assert.deepEqual(stamps, [0, 0, 1000, 2000, 3000]);
  });

  it("serves concurrent callers in FIFO order", async () => {
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 1, refillPerMinute: 60, now: clock.now, sleep: clock.sleep });
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3].map((i) => bucket.acquire().then(() => order.push(i))));
    assert.deepEqual(order, [0, 1, 2, 3]);
    assert.equal(clock.state.slept, 3000);
  });

  it("refills while idle but never beyond capacity", async () => {
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 3, refillPerMinute: 60, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 3; i++) await bucket.acquire();
    clock.advance(60_000); // would refill 60 tokens, capped at 3
    const before = clock.state.slept;
    for (let i = 0; i < 3; i++) await bucket.acquire();
    assert.equal(clock.state.slept, before, "burst after idle needs no waiting");
    await bucket.acquire();
    assert.equal(clock.state.slept - before, 1000, "4th request must wait one refill interval");
  });

  it("never exceeds capacity + rate in any 60s window", async () => {
    const clock = fakeTime();
    const bucket = new TokenBucket({ capacity: 9, refillPerMinute: 48, now: clock.now, sleep: clock.sleep });
    const stamps: number[] = [];
    for (let i = 0; i < 200; i++) {
      await bucket.acquire();
      stamps.push(clock.now());
    }
    for (let i = 0; i < stamps.length; i++) {
      const inWindow = stamps.filter((s) => s >= stamps[i]! && s < stamps[i]! + 60_000).length;
      assert.ok(inWindow <= 60, `window starting at request ${i} had ${inWindow} requests`);
    }
  });

  it("rejects invalid configuration", () => {
    assert.throws(() => new TokenBucket({ capacity: 0, refillPerMinute: 10 }));
    assert.throws(() => new TokenBucket({ capacity: 1, refillPerMinute: 0 }));
  });
});

describe("TtlCache", () => {
  it("returns hits until the TTL elapses, then misses", () => {
    const clock = fakeTime();
    const cache = new TtlCache<string>(12_000, clock.now);
    cache.set("k", "v");
    assert.equal(cache.get("k"), "v");
    clock.advance(11_999);
    assert.equal(cache.get("k"), "v");
    clock.advance(2);
    assert.equal(cache.get("k"), undefined);
    assert.equal(cache.size, 0, "expired entry is evicted on read");
  });

  it("wrap() de-duplicates concurrent loads and caches the result", async () => {
    const clock = fakeTime();
    const cache = new TtlCache<number>(1000, clock.now);
    let loads = 0;
    const loader = async () => ++loads;
    const [a, b, c] = await Promise.all([cache.wrap("x", loader), cache.wrap("x", loader), cache.wrap("x", loader)]);
    assert.deepEqual([a, b, c], [1, 1, 1]);
    assert.equal(await cache.wrap("x", loader), 1);
    assert.equal(loads, 1);
    clock.advance(1001);
    assert.equal(await cache.wrap("x", loader), 2);
  });

  it("does not cache failed loads", async () => {
    const cache = new TtlCache<number>(1000);
    let n = 0;
    await assert.rejects(cache.wrap("k", async () => { n++; throw new Error("boom"); }));
    assert.equal(await cache.wrap("k", async () => 42), 42);
    assert.equal(n, 1);
  });

  it("bounds its size", () => {
    const cache = new TtlCache<number>(60_000, Date.now, 5);
    for (let i = 0; i < 20; i++) cache.set(`k${i}`, i);
    assert.ok(cache.size <= 5);
    assert.equal(cache.get("k19"), 19);
  });
});

describe("helpers", () => {
  it("chunk splits into groups of at most N", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 3), []);
    assert.throws(() => chunk([1], 0));
  });

  it("mapLimit preserves order and respects the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
    assert.equal(peak, 2);
  });
});
