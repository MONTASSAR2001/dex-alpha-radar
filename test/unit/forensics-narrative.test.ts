import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DexScreenerClient } from "../../mcp-server/src/dexscreener.js";
import type { RugCheckReport } from "../../mcp-server/src/security.js";
import { SecurityAuditor } from "../../mcp-server/src/security.js";
import type { ToolDeps } from "../../mcp-server/src/tools/index.js";
import { evaluateCopycat, evaluateNarrativePulse, evaluateSocials, levenshtein, narrativeMomentum, similarity, themeKeywords, toRef, type TokenRef } from "../../mcp-server/src/tools/narrative-pulse.js";
import { analyzeHolderForensics, analyzeWhaleForensics, BUNDLE_THRESHOLDS } from "../../mcp-server/src/tools/whale-forensics.js";
import { fakeTime, makePair, mockFetch, NOW } from "../helpers.js";

const MINT = ("ForMint" + "1".repeat(40)).slice(0, 43);
const SUPPLY = 1_000_000_000_000_000; // raw units
const pctOf = (p: number) => (SUPPLY * p) / 100;

function report(over: Partial<RugCheckReport> = {}): RugCheckReport {
  return {
    token: { supply: SUPPLY, decimals: 6 },
    totalHolders: 800,
    creator: "CREATOR",
    creatorBalance: 0,
    graphInsidersDetected: 0,
    insiderNetworks: [],
    topHolders: [
      { address: "a1", owner: "w1", pct: 3.1, insider: false },
      { address: "a2", owner: "w2", pct: 2.4, insider: false },
      { address: "a3", owner: "w3", pct: 2.0, insider: false },
      { address: "a4", owner: "w4", pct: 1.6, insider: false },
      { address: "a5", owner: "w5", pct: 1.2, insider: false },
    ],
    knownAccounts: {},
    markets: [],
    ...over,
  };
}

const analyze = (r: RugCheckReport | undefined, pairOver = {}) => analyzeHolderForensics({ chain: "solana", address: MINT, report: r, pair: makePair({ addr: MINT, ...pairOver }), now: NOW });

describe("whale forensics: verdict", () => {
  it("CLEAN_DISTRIBUTION for a healthy spread, with a high Holder Safety Score", () => {
    const a = analyze(report());
    assert.equal(a.verdict, "CLEAN_DISTRIBUTION");
    assert.ok(a.holderSafetyScore! >= 85, String(a.holderSafetyScore));
    assert.equal(a.band, "HEALTHY");
    assert.equal(a.concentration.top1Pct, 3.1);
    assert.equal(a.concentration.top5Pct, 10.3);
  });

  it("BUNDLE_DETECTED when insider holders still own >= 10% of supply", () => {
    const r = report({ topHolders: [{ address: "x", owner: "i1", pct: 6, insider: true }, { address: "y", owner: "i2", pct: 5, insider: true }, { address: "z", owner: "w", pct: 2, insider: false }] });
    const a = analyze(r);
    assert.equal(a.verdict, "BUNDLE_DETECTED");
    assert.equal(a.insiders.flaggedHolderPct, 11);
    assert.match(a.reasons[0]!, /insiders still hold 11%/);
  });

  it("BUNDLE_DETECTED from insider network holdings, network count, graph size or launch distribution", () => {
    const net = (holding: number, distributed = 1) => ({ id: "n", size: 4, type: "transfer", tokenAmount: pctOf(distributed), currentHolding: pctOf(holding), activeAccounts: 4 });
    assert.equal(analyze(report({ insiderNetworks: [net(10)] })).verdict, "BUNDLE_DETECTED");
    assert.equal(analyze(report({ insiderNetworks: [net(9.9)] })).verdict, "CLEAN_DISTRIBUTION", "just under the holding threshold");
    assert.equal(analyze(report({ insiderNetworks: [net(1), net(1), net(1)] })).verdict, "BUNDLE_DETECTED");
    assert.equal(analyze(report({ insiderNetworks: [net(1), net(1)] })).verdict, "CLEAN_DISTRIBUTION");
    assert.equal(analyze(report({ graphInsidersDetected: BUNDLE_THRESHOLDS.graphInsiders })).verdict, "BUNDLE_DETECTED");
    assert.equal(analyze(report({ graphInsidersDetected: BUNDLE_THRESHOLDS.graphInsiders - 1 })).verdict, "CLEAN_DISTRIBUTION");
    assert.equal(analyze(report({ insiderNetworks: [net(1, 20)] })).verdict, "BUNDLE_DETECTED", ">= 20% routed through insiders at launch");
  });

  it("a bundled token's Holder Safety Score is capped at 40", () => {
    const a = analyze(report({ graphInsidersDetected: 40 }));
    assert.equal(a.verdict, "BUNDLE_DETECTED");
    assert.ok(a.holderSafetyScore! <= 40);
    assert.equal(a.band === "CAUTION" || a.band === "HIGH_RISK", true);
  });

  it("is fail-closed: no RugCheck report -> INSUFFICIENT_DATA and a null score, never CLEAN", () => {
    const a = analyze(undefined);
    assert.equal(a.verdict, "INSUFFICIENT_DATA");
    assert.equal(a.holderSafetyScore, null);
    assert.equal(a.band, "UNKNOWN");
    assert.match(a.reasons[0]!, /fail-closed/);
  });

  it("reports the real example: minor insider activity is noted but not a bundle", () => {
    const a = analyze(report({ graphInsidersDetected: 8, insiderNetworks: [{ id: "a", size: 4, type: "transfer", tokenAmount: pctOf(7.5), currentHolding: pctOf(1.7), activeAccounts: 4 }, { id: "b", size: 4, type: "transfer", tokenAmount: pctOf(2.3), currentHolding: pctOf(1.5), activeAccounts: 4 }] }));
    assert.equal(a.verdict, "CLEAN_DISTRIBUTION");
    assert.equal(a.insiders.networkHoldingPct, 3.2);
    assert.equal(a.insiders.networkDistributedPct, 9.8);
    assert.ok(a.reasons.some((r) => /Minor insider activity/.test(r)));
    assert.ok(a.holderSafetyScore! < analyze(report()).holderSafetyScore!, "minor insiders still cost points");
  });
});

describe("whale forensics: concentration and score", () => {
  it("excludes pools and lockers, keeps the creator wallet", () => {
    const a = analyze(
      report({
        creator: "CREATOR",
        topHolders: [
          { address: "v", owner: "market1", pct: 30, insider: false },
          { address: "l", owner: "lock1", pct: 12, insider: false },
          { address: "c", owner: "CREATOR", pct: 6, insider: false },
          { address: "w", owner: "w1", pct: 2, insider: false },
        ],
        markets: [{ pubkey: "market1" }],
        knownAccounts: { lock1: { type: "LOCKER" } },
      }),
    );
    assert.equal(a.concentration.poolsAndLockersExcluded, 2);
    assert.equal(a.concentration.top1Pct, 6);
    assert.equal(a.topHolders[0]!.isCreator, true);
  });

  it("scores worse as concentration, creator holding and insiders grow, always within 0-100", () => {
    const heavy = (pcts: number[]) => report({ topHolders: pcts.map((pct, i) => ({ address: `a${i}`, owner: `w${i}`, pct, insider: false })) });
    const healthy = analyze(heavy([3, 2, 2, 1, 1])).holderSafetyScore!;
    const mid = analyze(heavy([12, 8, 7, 6, 5, 4, 3, 2, 2, 1])).holderSafetyScore!;
    const bad = analyze(heavy([35, 15, 10, 8, 6, 5, 4, 3, 2, 2])).holderSafetyScore!;
    assert.ok(healthy > mid && mid > bad, `${healthy} ${mid} ${bad}`);
    for (const s of [healthy, mid, bad]) assert.ok(s >= 0 && s <= 100);
    assert.ok(analyze(report({ creatorBalance: pctOf(20) })).holderSafetyScore! < healthy);
    assert.equal(analyze(report({ creatorBalance: pctOf(20) })).concentration.creatorPct, 20);
  });

  it("flags wallet churn from DexScreener velocity (many buys per holder)", () => {
    const churn = analyze(report({ totalHolders: 100 }), { txns: { m5: { buys: 30, sells: 10 }, h1: { buys: 300, sells: 150 }, h24: { buys: 2000, sells: 1800 } } });
    assert.equal(churn.velocity.churnSuspected, true);
    assert.equal(churn.velocity.buysPerHolder24h, 20);
    assert.ok(churn.warnings.some((w) => /buys per holder/.test(w)));
    const normal = analyze(report({ totalHolders: 2000 }), { txns: { h24: { buys: 2000, sells: 1800 } } });
    assert.equal(normal.velocity.churnSuspected, false);
  });

  it("EVM: concentration only (contracts excluded), no bundle verdict claimed", () => {
    const a = analyzeHolderForensics({
      chain: "base",
      address: "0x" + "1".repeat(40),
      goplus: { holder_count: "1500", creator_percent: "0.02", holders: [{ address: "0xpool", percent: "0.55", is_contract: 1 }, { address: "0xa", percent: "0.10", is_contract: 0 }, { address: "0xb", percent: "0.05", is_contract: 0 }] },
      now: NOW,
    });
    assert.equal(a.verdict, "INSUFFICIENT_DATA");
    assert.equal(a.scoreBasis, "concentration-only");
    assert.equal(a.concentration.top1Pct, 10);
    assert.equal(a.concentration.top10Pct, 15);
    assert.equal(a.concentration.creatorPct, 2);
    assert.ok(a.holderSafetyScore !== null && a.holderSafetyScore > 0);
    assert.ok(a.warnings.some((w) => /EVM bundle detection is not available/.test(w)));
    assert.equal(analyzeHolderForensics({ chain: "base", address: "0x1", now: NOW }).holderSafetyScore, null);
  });
});

describe("analyzeWhaleForensics tool", () => {
  function deps(handler: Parameters<typeof mockFetch>[0]): ToolDeps {
    const clock = fakeTime(NOW);
    const { fn } = mockFetch(handler);
    const o = { fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 1, retries: 0 };
    return { dex: new DexScreenerClient(o), security: new SecurityAuditor(o), now: clock.now };
  }
  const pair = makePair({ addr: MINT, baseToken: { address: MINT, name: "Forensic", symbol: "FOR" } });

  it("combines RugCheck and DexScreener data", async () => {
    const d = deps((u) => (u.includes("rugcheck") ? { body: report() } : u.includes("/tokens/v1/solana/") ? { body: [pair] } : undefined));
    const r = await analyzeWhaleForensics(d, { address: MINT });
    assert.equal(r.verdict, "CLEAN_DISTRIBUTION");
    assert.equal(r.decimals, 6);
    assert.equal(r.token?.symbol, "FOR");
    assert.deepEqual(r.dataSources, ["rugcheck", "dexscreener"]);
    assert.ok(r.velocity.ageMinutes !== undefined);
  });

  it("fails closed when RugCheck is down, and still works without a DexScreener pair", async () => {
    const down = deps((u) => (u.includes("rugcheck") ? { status: 500 } : { body: [pair] }));
    const r = await analyzeWhaleForensics(down, { address: MINT });
    assert.equal(r.verdict, "INSUFFICIENT_DATA");
    assert.equal(r.holderSafetyScore, null);
    assert.ok(r.dataSources[0]!.includes("unavailable"));
    const nopair = deps((u) => (u.includes("rugcheck") ? { body: report() } : { body: [] }));
    assert.equal((await analyzeWhaleForensics(nopair, { address: MINT })).verdict, "CLEAN_DISTRIBUTION");
  });
});

// ---------------------------------------------------------------------------
// narrative
// ---------------------------------------------------------------------------

describe("similarity", () => {
  const tk = (symbol: string, name: string) => ({ symbol, name });

  it("matches same symbol, same name, near symbols and contained names", () => {
    assert.equal(similarity(tk("PEPE", "Pepe"), tk("pepe", "Pepe Coin")).score, 1);
    assert.deepEqual(similarity(tk("AAA", "Official Trump"), tk("BBB", "Trump Token")).reasons, ["same name"]);
    const near = similarity(tk("DOGWIFHAT", "x"), tk("DOGWIFHATS", "y"));
    assert.ok(near.score >= 0.8 && near.reasons[0]!.startsWith("similar symbol"));
    assert.ok(similarity(tk("AAA", "Baby Pepe"), tk("BBB", "Baby Pepe Inu")).score >= 0.75);
    assert.deepEqual(similarity(tk("AAA", "Doge Moon Rocket"), tk("BBB", "Moon Rocket")).reasons, ["name contains the other's name"]);
    assert.equal(similarity(tk("PEPE", "Pepe 2.0"), tk("XYZ", "Pepe")).reasons[0], "same name", "numeric suffixes are ignored");
  });

  it("does not match unrelated tokens or tiny symbols", () => {
    assert.equal(similarity(tk("BONK", "Bonk"), tk("WIF", "dogwifhat")).score, 0);
    assert.ok(similarity(tk("AB", "Alpha Beta"), tk("AC", "Alpha Charlie")).score < 0.75);
    assert.equal(levenshtein("kitten", "sitting"), 3);
  });

  it("extracts theme keywords", () => {
    assert.deepEqual(themeKeywords({ symbol: "TRUMPIN", name: "Official Trump Inauguration Coin" }), ["trump", "inauguration", "trumpin"]);
  });
});

describe("copycat evaluation", () => {
  const MIN = 60_000;
  const ref = (over: Partial<TokenRef> = {}): TokenRef => ({ symbol: "PEPE", name: "Pepe", chain: "solana", tokenAddress: "OTHER", createdAt: NOW - 300 * MIN, liquidityUsd: 500_000, volumeH24: 2_000_000, boosted: false, trending: true, ...over });
  const subject = ref({ tokenAddress: "SUBJ", symbol: "PEPE", name: "Pepe", createdAt: NOW - 10 * MIN, liquidityUsd: 30_000, volumeH24: 50_000, trending: false });

  it("HIGH: a larger, earlier, similar token is trending -> late copycat", () => {
    const c = evaluateCopycat(subject, [ref()]);
    assert.equal(c.risk, "HIGH");
    assert.equal(c.isLikelyOriginal, false);
    assert.equal(c.matches[0]!.relation, "EARLIER_ORIGINAL");
    assert.equal(c.matches[0]!.launchedMinutesEarlier, 290);
    assert.match(c.summary, /late copycat of \$PEPE/);
  });

  it("MEDIUM: similar token is earlier but smaller and not trending, or an identical twin launched at the same time", () => {
    const earlierSmall = evaluateCopycat(subject, [ref({ liquidityUsd: 5_000, volumeH24: 3_000, trending: false })]);
    assert.equal(earlierSmall.risk, "MEDIUM");
    assert.equal(earlierSmall.matches[0]!.relation, "EARLIER_SMALLER");
    const twin = evaluateCopycat(subject, [ref({ createdAt: NOW - 12 * MIN, trending: true })]);
    assert.equal(twin.risk, "MEDIUM");
    assert.equal(twin.matches[0]!.relation, "CONTEMPORARY");
  });

  it("a ticker-only collision with an older, bigger token is MEDIUM (possibly unrelated), never HIGH, unless that token is trending", () => {
    // The live false positive: a brand-new "Gekko Theft Auto" ($GTA) vs an old, large, unrelated "Grand Theft Auto" ($GTA).
    const young = ref({ tokenAddress: "NEW", symbol: "GTA", name: "Gekko Theft Auto", createdAt: NOW - 20 * MIN, liquidityUsd: 25_000, volumeH24: 80_000, trending: false });
    const oldLarge = ref({ tokenAddress: "OLD", symbol: "GTA", name: "Grand Theft Auto", createdAt: NOW - 150 * 24 * 60 * MIN, liquidityUsd: 15_000_000, volumeH24: 900_000, trending: false });
    const c = evaluateCopycat(young, [oldLarge]);
    assert.equal(c.risk, "MEDIUM");
    assert.equal(c.matches[0]!.relation, "EARLIER_SAME_TICKER");
    assert.match(c.summary, /shares the ticker but not the name.*possibly unrelated/);
    assert.equal(c.isLikelyOriginal, true, "a shared ticker alone does not make the subject a copy");
    // The same older token, but currently trending: now it is a real attention-weighted original.
    assert.equal(evaluateCopycat(young, [{ ...oldLarge, trending: true }]).risk, "HIGH");
    // And with a matching NAME it is HIGH on its own when larger.
    assert.equal(evaluateCopycat(young, [{ ...oldLarge, name: "Gekko Theft Auto" }]).risk, "HIGH");
  });

  it("an older look-alike with no market left is defunct, not an original, even if its profile appears in a trending feed", () => {
    // The second live false positive: a 300-day-old "GTA$" with $0 liquidity listed because its profile was updated.
    const young = ref({ tokenAddress: "NEW", symbol: "GTA", name: "Gekko Theft Auto", createdAt: NOW - 20 * MIN, liquidityUsd: 25_000, volumeH24: 80_000, trending: false });
    const dead = ref({ tokenAddress: "DEAD", symbol: "GTA", name: "Gekko Theft Auto", createdAt: NOW - 300 * 24 * 60 * MIN, liquidityUsd: 0, volumeH24: 0, trending: true, boosted: true });
    const c = evaluateCopycat(young, [dead]);
    assert.equal(c.matches[0]!.relation, "EARLIER_DEFUNCT");
    assert.equal(c.risk, "LOW");
    assert.equal(c.isLikelyOriginal, true);
    assert.match(c.summary, /1 defunct/);
    // A living market (even a modest one) is enough to count as the original again.
    assert.equal(evaluateCopycat(young, [{ ...dead, liquidityUsd: 30_000, volumeH24: 50_000 }]).risk, "HIGH");
    assert.equal(evaluateCopycat(young, [{ ...dead, liquidityUsd: 1_999, volumeH24: 1_999 }]).risk, "LOW");
  });

  it("an earlier token must be a comparable market: a much smaller older token that is trending is MEDIUM, not HIGH", () => {
    // Third live finding: a 3.5-day-old look-alike with ~$5k liquidity vs a ~$25k subject.
    const young = ref({ tokenAddress: "NEW", symbol: "GTA", name: "Gekko Theft Auto", createdAt: NOW - 20 * MIN, liquidityUsd: 25_000, volumeH24: 80_000, trending: false });
    const smallOlder = ref({ tokenAddress: "OLD", symbol: "GTA", name: "Gekko Theft Auto", createdAt: NOW - 5000 * MIN, liquidityUsd: 5_249, volumeH24: 10_000, trending: true });
    const c = evaluateCopycat(young, [smallOlder]);
    assert.equal(c.matches[0]!.relation, "EARLIER_SMALLER");
    assert.equal(c.risk, "MEDIUM");
    // At half the subject's size (liquidity) it becomes a credible original.
    assert.equal(evaluateCopycat(young, [{ ...smallOlder, liquidityUsd: 12_500 }]).risk, "HIGH");
    assert.equal(evaluateCopycat(young, [{ ...smallOlder, liquidityUsd: 12_499, volumeH24: 39_999 }]).risk, "MEDIUM");
    // Ticker-only + trending but not competitive stays a ticker collision.
    assert.equal(evaluateCopycat(young, [{ ...smallOlder, name: "Something Else" }]).matches[0]!.relation, "EARLIER_SAME_TICKER");
  });

  it("exposes which signal matched (name vs ticker)", () => {
    const s = similarity({ symbol: "GTA", name: "Gekko Theft Auto" }, { symbol: "GTA", name: "Grand Theft Auto" });
    assert.deepEqual([s.symbolMatch, s.nameMatch], [true, false]);
    const n = similarity({ symbol: "AAA", name: "Pepe Coin" }, { symbol: "BBB", name: "Pepe" });
    assert.deepEqual([n.symbolMatch, n.nameMatch], [false, true]);
  });

  it("LOW: only later clones exist (the subject looks like the original); NONE: nothing similar", () => {
    const later = evaluateCopycat(subject, [ref({ createdAt: NOW - 1 * MIN + 0, liquidityUsd: 100, trending: false }), ref({ tokenAddress: "C2", createdAt: NOW + 60 * MIN, trending: false, liquidityUsd: 100, volumeH24: 1 })]);
    assert.equal(later.risk, "LOW");
    assert.equal(later.isLikelyOriginal, true);
    const none = evaluateCopycat(subject, [ref({ symbol: "WIF", name: "dogwifhat" })]);
    assert.equal(none.risk, "NONE");
    assert.deepEqual(none.matches, []);
  });

  it("ignores the subject itself and treats a missing launch time conservatively as contemporary", () => {
    assert.equal(evaluateCopycat(subject, [{ ...subject }]).risk, "NONE");
    const c = evaluateCopycat({ ...subject, createdAt: undefined }, [ref()]);
    assert.equal(c.matches[0]!.relation, "CONTEMPORARY");
  });

  it("builds refs from DexScreener pairs", () => {
    const r = toRef(makePair({ addr: "Aaaa", boosts: { active: 2 } }), true);
    assert.equal(r.boosted, true);
    assert.equal(r.trending, true);
    assert.equal(r.liquidityUsd, 80_000);
  });
});

describe("social presence", () => {
  const pair = (websites: string[], socials: [string, string][]) => makePair({ info: { websites: websites.map((url) => ({ url })), socials: socials.map(([type, url]) => ({ type, url })) } });

  it("scores valid website, X and Telegram links at 100", () => {
    const s = evaluateSocials([pair(["https://pepe.fun"], [["twitter", "https://x.com/pepe"], ["telegram", "https://t.me/pepechat"]])]);
    assert.equal(s.score, 100);
    assert.deepEqual([s.website.valid, s.x.valid, s.telegram.valid], [true, true, true]);
    assert.match(s.verification, /not independently verified/);
  });

  it("gives half credit and an issue for links on the wrong host", () => {
    const s = evaluateSocials([pair(["http://pepe.fun"], [["twitter", "https://example.com/pepe"], ["telegram", "https://t.me/"]])]);
    assert.equal(s.score, 15 + 20 + 15);
    assert.equal(s.issues.length, 3);
    assert.equal(evaluateSocials([pair(["https://linktr.ee/pepe"], [])]).website.valid, false);
  });

  it("scores zero when nothing is listed and merges links across pools", () => {
    assert.equal(evaluateSocials([pair([], [])]).score, 0);
    assert.equal(evaluateSocials([pair([], []), pair(["https://a.io"], [["x", "https://twitter.com/a"]])]).score, 70);
  });
});

describe("narrative momentum", () => {
  const hot = makePair({ liquidity: { usd: 20_000 }, volume: { m5: 20_000, h1: 40_000 }, txns: { m5: { buys: 40, sells: 8 }, h1: { buys: 300, sells: 100 } }, priceChange: { h1: 40, h24: 100 } });

  it("rewards attention, buy pressure, catalysts and socials; stays within 0-100", () => {
    const strong = narrativeMomentum({ pair: hot, trendingSources: 4, boosted: true, cto: true, socialScore: 100 });
    const weak = narrativeMomentum({ pair: makePair({ volume: { m5: 0, h1: 0 }, txns: undefined, priceChange: { h1: -20, h24: -40 } }), trendingSources: 0, boosted: false, cto: false, socialScore: 0 });
    assert.ok(strong.score > 80 && strong.score <= 100, String(strong.score));
    assert.equal(weak.score, 0);
    assert.ok(strong.reasons.length >= 3);
  });

  it("discounts momentum built on bot volume", () => {
    const botted = makePair({ ...hot, txns: { m5: { buys: 4000, sells: 800 }, h1: { buys: 30_000, sells: 10_000 } } });
    const real = narrativeMomentum({ pair: hot, trendingSources: 2, boosted: false, cto: false, socialScore: 50 });
    const fake = narrativeMomentum({ pair: botted, trendingSources: 2, boosted: false, cto: false, socialScore: 50 });
    assert.ok(fake.components.washPenalty < 0);
    assert.ok(fake.score < real.score);
  });
});

describe("evaluateNarrativePulse tool", () => {
  const ORIG = ("RigMint" + "1".repeat(40)).slice(0, 43);
  const COPY = ("CopyMint" + "1".repeat(40)).slice(0, 43);
  const original = makePair({ addr: ORIG, baseToken: { address: ORIG, name: "Pepe Coin", symbol: "PEPE" }, pairCreatedAt: NOW - 300 * 60_000, liquidity: { usd: 400_000 }, volume: { h24: 3_000_000, h1: 200_000, m5: 15_000 } });
  const copy = makePair({ addr: COPY, baseToken: { address: COPY, name: "Pepe", symbol: "PEPE" }, pairCreatedAt: NOW - 8 * 60_000, liquidity: { usd: 20_000 }, volume: { h24: 30_000, h1: 30_000, m5: 8_000 } });

  function deps() {
    const clock = fakeTime(NOW);
    const { fn } = mockFetch((u) => {
      if (u.includes("/token-boosts/latest")) return { body: [{ chainId: "solana", tokenAddress: ORIG, totalAmount: 100 }] };
      if (u.includes("/token-boosts/top") || u.includes("/token-profiles") || u.includes("/community-takeovers")) return { body: [] };
      if (u.includes("/tokens/v1/solana/")) return { body: u.includes(ORIG) ? [original] : [] };
      if (u.includes("/latest/dex/search")) return { body: { pairs: [original, copy] } };
      return undefined;
    });
    const o = { fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 1, retries: 0 };
    return { dex: new DexScreenerClient(o), security: new SecurityAuditor(o), now: clock.now } as ToolDeps;
  }

  it("flags a late copycat of a trending token (HIGH) and says so in the verdict and warnings", async () => {
    const r = await evaluateNarrativePulse(deps(), { query: COPY, chain: "solana" });
    assert.ok(r.found);
    if (!r.found) return;
    assert.equal(r.copycat.risk, "HIGH");
    assert.equal(r.verdict, "LATE_COPYCAT");
    assert.equal(r.copycatFlag, true);
    assert.equal(r.copycat.matches[0]!.tokenAddress, ORIG);
    assert.ok(r.copycat.matches[0]!.trending);
    assert.ok(r.warnings.some((w) => /late copycat of \$PEPE/.test(w)));
    assert.ok(r.copycat.comparedAgainst >= 1);
  });

  it("recognises the original (older, bigger, trending) as the original, with the copy as a later clone", async () => {
    const r = await evaluateNarrativePulse(deps(), { query: ORIG, chain: "solana" });
    assert.ok(r.found);
    if (!r.found) return;
    assert.equal(r.copycat.risk, "LOW");
    assert.equal(r.copycat.isLikelyOriginal, true);
    assert.equal(r.copycat.matches[0]!.relation, "LATER_CLONE");
    assert.notEqual(r.verdict, "LATE_COPYCAT");
    assert.equal(r.catalysts.trendingSources, 1);
    assert.equal(r.catalysts.boosted, true);
    assert.ok(r.momentum.score >= 0 && r.momentum.score <= 100);
    assert.match(r.dataNotes, /not measured/);
  });

  it("reports unknown tokens cleanly and degrades when trending sources fail", async () => {
    const empty = await evaluateNarrativePulse(deps(), { query: "zzznothing", chain: "solana" });
    assert.equal(empty.found, false);
    const clock = fakeTime(NOW);
    const { fn } = mockFetch((u) => (u.includes("/latest/dex/search") ? { body: { pairs: [original] } } : { status: 400 }));
    const o = { fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 1, retries: 0 };
    const r = await evaluateNarrativePulse({ dex: new DexScreenerClient(o), security: new SecurityAuditor(o), now: clock.now }, { query: ORIG });
    assert.ok(r.found);
    if (r.found) assert.ok(r.warnings.some((w) => /Trending comparison unavailable/.test(w)));
  });
});
