import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bestPairPerToken, DexScreenerClient, ENDPOINT_LIMITS, MAX_ADDRESSES_PER_CALL } from "../../mcp-server/src/dexscreener.js";
import { fetchJson, HttpError } from "../../mcp-server/src/http.js";
import { fakeTime, makePair, mockFetch } from "../helpers.js";

const addr = (i: number) => `Mint${String(i).padStart(40, "0")}`;

function clientWith(handler: Parameters<typeof mockFetch>[0]) {
  const clock = fakeTime();
  const { fn, calls } = mockFetch(handler);
  const client = new DexScreenerClient({ fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 100 });
  return { client, calls, clock };
}

describe("DexScreener batch grouping", () => {
  it("splits 65 addresses into 3 calls of <= 30", async () => {
    const { client, calls } = clientWith(() => ({ body: [] }));
    await client.getTokenPairs("solana", Array.from({ length: 65 }, (_, i) => addr(i)));
    assert.equal(calls.length, 3);
    const sizes = calls.map((u) => u.split("/tokens/v1/solana/")[1]!.split(",").length).sort((a, b) => a - b);
    assert.deepEqual(sizes, [5, 30, 30]);
    assert.ok(sizes.every((s) => s <= MAX_ADDRESSES_PER_CALL));
  });

  it("uses exactly one call for 30 addresses and de-duplicates", async () => {
    const { client, calls } = clientWith(() => ({ body: [] }));
    const list = Array.from({ length: 30 }, (_, i) => addr(i));
    await client.getTokenPairs("solana", [...list, ...list]);
    assert.equal(calls.length, 1);
  });

  it("de-duplicates EVM addresses case-insensitively but keeps Solana case", async () => {
    const { client, calls } = clientWith(() => ({ body: [] }));
    await client.getTokenPairs("base", ["0xAbCDEF0000000000000000000000000000000001", "0xabcdef0000000000000000000000000000000001"]);
    assert.equal(calls[0]!.split("/tokens/v1/base/")[1]!.split(",").length, 1);
    const sol = clientWith(() => ({ body: [] }));
    await sol.client.getTokenPairs("solana", ["AbcdEfghijkLMNopqrstuvwxyz123456789", "abcdefghijklmnopqrstuvwxyz123456789"]);
    assert.equal(sol.calls[0]!.split("/tokens/v1/solana/")[1]!.split(",").length, 2);
  });

  it("makes no request for an empty list, and rejects unsafe path segments", async () => {
    const { client, calls } = clientWith(() => ({ body: [] }));
    assert.deepEqual(await client.getTokenPairs("solana", []), []);
    assert.equal(calls.length, 0);
    await assert.rejects(client.getTokenPairs("solana", ["abc/../../etc"]), /Invalid token address/);
    await assert.rejects(client.getTokenPairs("sol ana", ["abc"]), /Invalid chainId/);
  });

  it("flattens results and drops malformed pairs", async () => {
    const good = makePair({ addr: addr(1) });
    const { client } = clientWith(() => ({ body: [good, { chainId: "solana" }, null] }));
    const pairs = await client.getTokenPairs("solana", [addr(1)]);
    assert.equal(pairs.length, 1);
  });

  it("keeps the exact priceUsd string from the API", async () => {
    const { client } = clientWith(() => ({ body: [makePair({ addr: addr(1), priceUsd: "0.0000000004321" })] }));
    const [p] = await client.getTokenPairs("solana", [addr(1)]);
    assert.equal(p!.priceUsd, "0.0000000004321");
  });

  it("bestPairPerToken keeps the deepest pool for each token", () => {
    const a1 = makePair({ addr: addr(1), liquidity: { usd: 1_000 } });
    const a2 = { ...makePair({ addr: addr(1), liquidity: { usd: 9_000 } }), pairAddress: "deeper" };
    const b = makePair({ addr: addr(2), liquidity: { usd: 500 } });
    const best = bestPairPerToken([a1, a2, b]);
    assert.equal(best.size, 2);
    assert.equal([...best.values()].find((p) => p.baseToken.address === addr(1))!.pairAddress, "deeper");
  });
});

describe("DexScreener endpoints", () => {
  it("hits the documented URLs", async () => {
    const { client, calls } = clientWith((url) => (url.includes("/latest/dex/") ? { body: { pairs: [] } } : { body: [] }));
    await client.boostsLatest();
    await client.boostsTop();
    await client.profilesLatest();
    await client.ctoLatest();
    await client.search("SOL & co");
    await client.getPair("solana", "PAIR123");
    assert.deepEqual(calls, [
      "https://api.dexscreener.com/token-boosts/latest/v1",
      "https://api.dexscreener.com/token-boosts/top/v1",
      "https://api.dexscreener.com/token-profiles/latest/v1",
      "https://api.dexscreener.com/community-takeovers/latest/v1",
      "https://api.dexscreener.com/latest/dex/search?q=SOL%20%26%20co",
      "https://api.dexscreener.com/latest/dex/pairs/solana/PAIR123",
    ]);
  });

  it("normalises a single-object response to an array", async () => {
    const { client } = clientWith(() => ({ body: { chainId: "solana", tokenAddress: "abc" } }));
    assert.equal((await client.boostsLatest()).length, 1);
  });

  it("declares the documented rate limits", () => {
    assert.equal(ENDPOINT_LIMITS.boostsLatest, 60);
    assert.equal(ENDPOINT_LIMITS.boostsTop, 60);
    assert.equal(ENDPOINT_LIMITS.profilesLatest, 60);
    assert.equal(ENDPOINT_LIMITS.ctoLatest, 60);
    assert.equal(ENDPOINT_LIMITS.tokens, 300);
    assert.equal(ENDPOINT_LIMITS.search, 300);
    assert.equal(ENDPOINT_LIMITS.pairs, 300);
  });
});

describe("DexScreener 12s TTL cache", () => {
  it("serves repeated queries from cache within 12 seconds, then refetches", async () => {
    const { client, calls, clock } = clientWith(() => ({ body: [] }));
    await client.boostsLatest();
    clock.advance(11_000);
    await client.boostsLatest();
    assert.equal(calls.length, 1);
    clock.advance(1_500);
    await client.boostsLatest();
    assert.equal(calls.length, 2);
  });

  it("collapses concurrent identical queries into one request", async () => {
    const { client, calls } = clientWith(() => ({ body: { pairs: [] } }));
    await Promise.all(Array.from({ length: 10 }, () => client.search("pepe")));
    assert.equal(calls.length, 1);
    assert.equal(client.requestCount, 1);
  });
});

describe("DexScreener rate-limit protection", () => {
  it("paces 150 distinct calls so no 60s window exceeds 300 req/min", async () => {
    const clock = fakeTime();
    const stamps: number[] = [];
    const { fn } = mockFetch(() => ({ body: { pairs: [] } }), () => stamps.push(clock.now()));
    const client = new DexScreenerClient({ fetchImpl: fn, now: clock.now, sleep: clock.sleep });
    await Promise.all(Array.from({ length: 150 }, (_, i) => client.getPair("solana", `P${i}`)));
    assert.equal(stamps.length, 150);
    for (const s of stamps) {
      assert.ok(stamps.filter((x) => x >= s && x < s + 60_000).length <= 300);
    }
    // 45 burst + 105 more at 4/s => ~26s of pacing was needed.
    assert.ok(clock.state.slept >= 25_000 && clock.state.slept <= 28_000, `slept ${clock.state.slept}`);
  });

  it("keeps the 60/min endpoints on their own, slower budget", async () => {
    const clock = fakeTime();
    const { fn, calls } = mockFetch(() => ({ body: [] }));
    const client = new DexScreenerClient({ fetchImpl: fn, now: clock.now, sleep: clock.sleep, cacheTtlMs: 1 });
    for (let i = 0; i < 20; i++) {
      clock.advance(5); // expire the cache so each call is a real request
      await client.boostsLatest();
    }
    assert.equal(calls.length, 20);
    // capacity 9, then 48/min => 11 extra requests need ~13.75s
    assert.ok(clock.state.slept >= 13_000, `slept ${clock.state.slept}`);
  });
});

describe("backoff on 429 / 5xx", () => {
  it("retries 429 with exponential backoff then succeeds", async () => {
    const { client, calls, clock } = clientWith((_u, n) => (n <= 2 ? { status: 429 } : { body: [{ chainId: "solana", tokenAddress: "x" }] }));
    const out = await client.boostsLatest();
    assert.equal(out.length, 1);
    assert.equal(calls.length, 3);
    // base 100ms: ~100-125ms then ~200-225ms
    assert.ok(clock.state.slept >= 300 && clock.state.slept < 400, `slept ${clock.state.slept}`);
  });

  it("honours Retry-After", async () => {
    const { client, clock } = clientWith((_u, n) => (n === 1 ? { status: 429, headers: { "retry-after": "3" } } : { body: [] }));
    await client.boostsLatest();
    assert.ok(clock.state.slept >= 3000);
  });

  it("retries 5xx and network errors, gives up after the retry budget", async () => {
    const { client, calls } = clientWith(() => ({ status: 503 }));
    await assert.rejects(client.boostsLatest(), (e: unknown) => e instanceof HttpError && e.status === 503);
    assert.equal(calls.length, 4); // 1 + 3 retries
    const net = clientWith((_u, n) => (n < 3 ? { throws: new TypeError("fetch failed") } : { body: [] }));
    assert.deepEqual(await net.client.boostsLatest(), []);
  });

  it("does not retry other 4xx errors", async () => {
    const { client, calls } = clientWith(() => ({ status: 400 }));
    await assert.rejects(client.boostsLatest(), (e: unknown) => e instanceof HttpError && e.status === 400);
    assert.equal(calls.length, 1);
  });

  it("does not cache failures", async () => {
    const { client, calls } = clientWith((_u, n) => (n <= 4 ? { status: 500 } : { body: [] }));
    await assert.rejects(client.boostsLatest());
    await client.boostsLatest();
    assert.equal(calls.length, 5);
  });

  it("fetchJson reports invalid JSON", async () => {
    const fetchImpl = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    await assert.rejects(fetchJson("http://x", { fetchImpl, retries: 0 }), /not valid JSON/);
  });
});
