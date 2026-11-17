import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrowserTrendingResult } from "../../mcp-server/src/browserFallback.js";
import { DexScreenerClient } from "../../mcp-server/src/dexscreener.js";
import { SecurityAuditor } from "../../mcp-server/src/security.js";
import { scanOpportunities, type ToolDeps } from "../../mcp-server/src/tools.js";
import { fakeTime, makePair, mockFetch, NOW } from "../helpers.js";

const REAL = ("ReaMint" + "1".repeat(40)).slice(0, 43);
const BOT = ("BotMint" + "1".repeat(40)).slice(0, 43);
const TREND = ("TrendMint" + "1".repeat(40)).slice(0, 43);
const TREND_PAIR = ("TrendPair" + "1".repeat(40)).slice(0, 43);

const botVolume = { volume: { m5: 5_000, h1: 60_000 }, txns: { m5: { buys: 900, sells: 300 }, h1: { buys: 20_000, sells: 10_000 } } }; // $2/trade
const pairs: Record<string, ReturnType<typeof makePair>> = {
  [REAL]: makePair({ addr: REAL, baseToken: { address: REAL, name: "Real", symbol: "REAL" } }),
  [BOT]: makePair({ addr: BOT, baseToken: { address: BOT, name: "Bot", symbol: "BOT" }, ...botVolume }),
  [TREND]: makePair({ addr: TREND, baseToken: { address: TREND, name: "Trendy", symbol: "TREND" }, pairAddress: TREND_PAIR }),
};

function setup(trending?: BrowserTrendingResult) {
  const clock = fakeTime(NOW);
  const { fn, calls } = mockFetch((url) => {
    if (url.includes("/token-boosts/latest")) return { body: [REAL, BOT].map((t) => ({ chainId: "solana", tokenAddress: t, totalAmount: 20 })) };
    if (url.includes("/token-boosts/top") || url.includes("/community-takeovers")) return { body: [] };
    if (url.includes("/token-profiles")) return { body: [] };
    if (url.includes("/tokens/v1/solana/")) return { body: url.split("/tokens/v1/solana/")[1]!.split(",").map((a) => pairs[a]).filter(Boolean) };
    if (url.includes("/latest/dex/pairs/solana/")) {
      const ids = url.split("/latest/dex/pairs/solana/")[1]!.split(",");
      return { body: { pairs: Object.values(pairs).filter((p) => ids.includes(p.pairAddress)) } };
    }
    if (url.includes("rugcheck.xyz")) {
      return { body: { score_normalised: 3, risks: [], mintAuthority: null, freezeAuthority: null, topHolders: [{ pct: 30 }, { pct: 15 }, { pct: 5 }] } };
    }
    return undefined;
  });
  const opts = { fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 5, retries: 1 };
  const trendingCalls: unknown[] = [];
  const deps: ToolDeps = {
    dex: new DexScreenerClient(opts),
    security: new SecurityAuditor(opts),
    now: clock.now,
    trending: trending ? async (o) => (trendingCalls.push(o), trending) : undefined,
  };
  return { deps, calls, trendingCalls };
}

describe("scan_opportunities anti-wash filters", () => {
  it("penalises bot-volume pairs, ranks them below real ones, and explains why in `warnings`", async () => {
    const { deps } = setup();
    const r = await scanOpportunities(deps, { chain: "solana" });
    assert.deepEqual(r.results.map((x) => x.symbol), ["REAL", "BOT"]);
    const [real, bot] = r.results as [(typeof r.results)[number], (typeof r.results)[number]];
    assert.equal(real.tradeQuality.washSuspected, false);
    assert.equal(bot.tradeQuality.washSuspected, true);
    assert.equal(bot.tradeQuality.avgTradeUsd1h, 2);
    assert.ok(bot.scoreBreakdown.manipulationPenalty < 0);
    assert.ok(bot.warnings.some((w) => /Low avg trade size \(\$2\.00\)/.test(w)));
    assert.deepEqual(real.warnings.filter((w) => /bot|wash/i.test(w)), []);
  });

  it("every candidate has a warnings array, including holder concentration from the deep audit", async () => {
    const { deps } = setup();
    const r = await scanOpportunities(deps, { chain: "solana" });
    for (const x of r.results) {
      assert.ok(Array.isArray(x.warnings));
      assert.ok(x.warnings.includes("High top-10 holder concentration (50%)"), JSON.stringify(x.warnings));
    }
  });

  it("deep-audits only the shortlist (1 summary + 1 report call per returned token)", async () => {
    const { deps, calls } = setup();
    const r = await scanOpportunities(deps, { chain: "solana" });
    const rug = calls.filter((u) => u.includes("rugcheck.xyz"));
    assert.equal(rug.filter((u) => u.endsWith("/report")).length, r.results.length);
    assert.equal(rug.filter((u) => u.endsWith("/summary")).length, 2);
  });
});

describe("scan_opportunities useBrowserTrending", () => {
  const ok: BrowserTrendingResult = { status: "ok", message: "Extracted 1", pairs: [{ chainId: "solana", pairAddress: TREND_PAIR, rank: 1 }] };

  it("is not invoked unless requested", async () => {
    const { deps, trendingCalls } = setup(ok);
    const r = await scanOpportunities(deps, { chain: "solana" });
    assert.equal(trendingCalls.length, 0);
    assert.equal("trending" in r, false);
  });

  it("feeds trending pairs through the same batch + audit + score pipeline", async () => {
    const { deps, calls, trendingCalls } = setup(ok);
    const r = await scanOpportunities(deps, { chain: "solana", useBrowserTrending: true });
    assert.deepEqual(trendingCalls, [{ chain: "solana", limit: 30 }]);
    assert.ok(calls.some((u) => u.includes(`/latest/dex/pairs/solana/${TREND_PAIR}`)), "pair -> token resolution via the batch pairs endpoint");
    const t = r.results.find((x) => x.symbol === "TREND");
    assert.ok(t, "trending token was scored");
    assert.equal(t.security.status, "SAFE", "and security-audited");
    assert.ok(t.alphaScore > 0);
    assert.deepEqual(r.trending, { requested: true, status: "ok", pairsFound: 1, tokensAdded: 1, message: "Extracted 1" });
    assert.equal(r.stats.candidates, 3);
  });

  it("degrades gracefully: unavailable browser leaves the API results intact and explains why", async () => {
    const { deps } = setup({ status: "unavailable", pairs: [], message: "Browser trending unavailable: no Chrome/Chromium found." });
    const r = await scanOpportunities(deps, { chain: "solana", useBrowserTrending: true });
    assert.deepEqual(r.results.map((x) => x.symbol), ["REAL", "BOT"]);
    assert.equal(r.trending?.status, "unavailable");
    assert.ok(r.warnings.some((w) => /no Chrome/.test(w)));
  });

  it("a crashing trending provider never breaks the scan", async () => {
    const { deps } = setup();
    deps.trending = async () => {
      throw new Error("kaboom");
    };
    const r = await scanOpportunities(deps, { chain: "solana", useBrowserTrending: true });
    assert.equal(r.trending?.status, "error");
    assert.ok(r.results.length > 0);
  });

  it("still works when REST discovery is down but trending succeeded", async () => {
    const clock = fakeTime(NOW);
    const { fn } = mockFetch((url) => {
      if (url.includes("/token-boosts") || url.includes("/token-profiles") || url.includes("/community-takeovers")) return { status: 400 };
      if (url.includes("/latest/dex/pairs/solana/")) return { body: { pairs: [pairs[TREND]] } };
      if (url.includes("/tokens/v1/solana/")) return { body: [pairs[TREND]] };
      if (url.includes("rugcheck.xyz")) return { body: { score_normalised: 3, risks: [], mintAuthority: null, freezeAuthority: null } };
      return undefined;
    });
    const opts = { fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 5, retries: 0 };
    const deps: ToolDeps = { dex: new DexScreenerClient(opts), security: new SecurityAuditor(opts), now: clock.now, trending: async () => ok };
    const r = await scanOpportunities(deps, { chain: "solana", useBrowserTrending: true });
    assert.deepEqual(r.results.map((x) => x.symbol), ["TREND"]);
    assert.ok(r.warnings.some((w) => /All DexScreener discovery endpoints failed/.test(w)));
  });
});
