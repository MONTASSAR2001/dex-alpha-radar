import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeWashTrading, buildWarnings, computeAlphaScore, detectBreakout, MAX_MANIPULATION_PENALTY } from "../../mcp-server/src/scoring.js";
import { holderConcentration, classifyGoPlus, classifyRugCheck } from "../../mcp-server/src/security.js";
import type { Catalysts, SecurityReport } from "../../mcp-server/src/types.js";
import { makePair, NOW } from "../helpers.js";

const none: Catalysts = { boosted: false, cto: false };
const sec = (over: Partial<SecurityReport> = {}): SecurityReport => ({ status: "SAFE", chainId: "solana", address: "x", source: "rugcheck", verdict: "SAFE: ok.", flags: [], ...over });

describe("average trade size (bot volume)", () => {
  it("penalises a tiny average trade despite many transactions and reports the exact figure", () => {
    // $2,100 / 500 txns = $4.20
    const pair = makePair({ volume: { m5: 100, h1: 2_100 }, txns: { h1: { buys: 300, sells: 200 } } });
    const w = analyzeWashTrading(pair);
    assert.equal(w.avgTradeUsd, 4.2);
    assert.equal(w.suspected, true);
    assert.ok(w.penalty > 6 && w.penalty < 10, `penalty ${w.penalty}`);
    assert.equal(w.warnings[0], "Low avg trade size ($4.20) over 500 txns in 1h: possible bot volume");
  });

  it("scales the penalty: $1 or less is worst, $15 is free", () => {
    const at = (usd: number) => analyzeWashTrading(makePair({ volume: { h1: usd * 200 }, txns: { h1: { buys: 100, sells: 100 } } })).penalty;
    assert.equal(at(0.5), 12);
    assert.ok(at(5) < at(1) && at(10) < at(5));
    assert.equal(at(15), 0);
    assert.equal(at(200), 0);
  });

  it("ignores small samples: few transactions are not 'high txn counts'", () => {
    const w = analyzeWashTrading(makePair({ volume: { h1: 40 }, txns: { h1: { buys: 6, sells: 4 } } }));
    assert.equal(w.suspected, false);
    assert.equal(w.penalty, 0);
  });

  it("handles missing data without NaN", () => {
    const w = analyzeWashTrading(makePair({ volume: undefined, txns: undefined, priceChange: undefined }));
    assert.equal(w.avgTradeUsd, undefined);
    assert.equal(w.penalty, 0);
    assert.deepEqual(w.warnings, []);
  });
});

describe("volume-to-liquidity sanity", () => {
  const base = { liquidity: { usd: 20_000 }, volume: { m5: 30_000, h1: 500_000 }, txns: { h1: { buys: 300, sells: 300 } } }; // 25x, avg $833

  it("flags > 20x liquidity with flat price", () => {
    const w = analyzeWashTrading(makePair({ ...base, priceChange: { h1: 1.2 } }));
    assert.equal(w.suspected, true);
    assert.equal(w.penalty, 10);
    assert.match(w.warnings[0]!, /1h volume is 25\.0x liquidity with flat price \(\+1\.2%\): possible wash trading/);
  });

  it("does not flag the same turnover when price actually moved", () => {
    assert.equal(analyzeWashTrading(makePair({ ...base, priceChange: { h1: 60 } })).suspected, false);
    assert.equal(analyzeWashTrading(makePair({ ...base, priceChange: { h1: -35 } })).suspected, false);
  });

  it("does not flag turnover at or below 20x", () => {
    assert.equal(analyzeWashTrading(makePair({ ...base, volume: { h1: 400_000 }, priceChange: { h1: 0 } })).suspected, false);
  });

  it("combined signals are capped at the maximum penalty", () => {
    const w = analyzeWashTrading(makePair({ liquidity: { usd: 1_000 }, volume: { h1: 100_000 }, txns: { h1: { buys: 90_000, sells: 90_000 } }, priceChange: { h1: 0 } }));
    assert.equal(w.penalty, MAX_MANIPULATION_PENALTY === 20 ? 20 : w.penalty);
    assert.ok(w.penalty <= MAX_MANIPULATION_PENALTY);
    assert.equal(w.warnings.length, 2);
  });
});

describe("wash trading in the Alpha Score", () => {
  it("lowers the score versus an otherwise identical clean pair and shows it in the breakdown", () => {
    const clean = makePair();
    const botted = makePair({ volume: { m5: 20_000, h1: 80_000 }, txns: { m5: { buys: 30, sells: 10 }, h1: { buys: 30_000, sells: 15_000 } } }); // $1.78 avg
    const a = computeAlphaScore(clean, none, sec(), NOW);
    const b = computeAlphaScore(botted, none, sec(), NOW);
    assert.equal(a.breakdown.manipulationPenalty, 0);
    assert.ok(b.breakdown.manipulationPenalty < -9, `${b.breakdown.manipulationPenalty}`);
    assert.ok(a.alphaScore - b.alphaScore >= 9);
    assert.ok(b.warnings.some((w) => /possible bot volume/.test(w)));
  });

  it("keeps the score within 0-100 and the sum of components consistent", () => {
    const s = computeAlphaScore(makePair({ volume: { h1: 900 }, txns: { h1: { buys: 800, sells: 800 } } }), none, sec({ status: "UNVERIFIED" }), NOW);
    const b = s.breakdown;
    assert.ok(s.alphaScore >= 0 && s.alphaScore <= 100);
    assert.ok(Math.abs(b.liquidity + b.pressure + b.velocity + b.social + b.manipulationPenalty + b.securityAdjustment - s.alphaScore) < 0.2);
  });

  it("a surge with bot-sized trades is not a breakout", () => {
    const real = makePair({ volume: { m5: 20_000, h1: 60_000 }, txns: { m5: { buys: 40, sells: 10 }, h1: { buys: 150, sells: 100 } }, priceChange: { m5: 5, h1: 20 } });
    assert.equal(detectBreakout(real).isBreakout, true);
    const bots = { ...real, volume: { m5: 20_000, h1: 60_000 }, txns: { m5: { buys: 4_000, sells: 1_000 }, h1: { buys: 15_000, sells: 10_000 } } }; // $2.40 avg
    const sig = detectBreakout(bots);
    assert.equal(sig.washSuspected, true);
    assert.equal(sig.isBreakout, false);
  });
});

describe("warnings array", () => {
  const pair = makePair();
  const wash = analyzeWashTrading(pair);

  it("is empty for a healthy, audited pair", () => {
    assert.deepEqual(buildWarnings(pair, wash, sec({ top10HolderPct: 15 }), NOW), []);
  });

  it("reports concentration, unverified contracts and security gaps", () => {
    const w = buildWarnings(pair, wash, sec({ chainId: "base", source: "goplus", isOpenSource: false, top10HolderPct: 48, mintAuthorityActive: true, sellTax: 0.12 }), NOW);
    assert.ok(w.includes("High top-10 holder concentration (48%)"));
    assert.ok(w.some((x) => x.startsWith("Unverified contract")));
    assert.ok(w.some((x) => /Mint authority is active/.test(x)));
    assert.ok(w.includes("Sell tax 12%"));
  });

  it("flags unverified audits, thin liquidity, fragile FDV ratios and brand-new pairs", () => {
    const risky = makePair({ liquidity: { usd: 4_200 }, fdv: 90_000_000, pairCreatedAt: NOW - 20 * 60_000 });
    const w = buildWarnings(risky, analyzeWashTrading(risky), sec({ status: "UNVERIFIED" }), NOW);
    assert.ok(w.some((x) => /UNVERIFIED/.test(x)));
    assert.ok(w.some((x) => /Thin liquidity \(\$4\.2k\)/.test(x)));
    assert.ok(w.some((x) => /of FDV/.test(x)));
    assert.ok(w.some((x) => /Very new pair \(20 min old\)/.test(x)));
  });

  it("falls back to a single-wallet warning below the top-10 threshold", () => {
    assert.ok(buildWarnings(pair, wash, sec({ topHolderPct: 27, top10HolderPct: 35 }), NOW).some((x) => /Single wallet holds 27%/.test(x)));
  });

  it("de-duplicates, and is attached to every scored candidate", () => {
    const scored = computeAlphaScore(makePair({ liquidity: { usd: 3_000 } }), none, sec({ status: "DANGER", verdict: "DANGER: x" }), NOW);
    assert.equal(new Set(scored.warnings).size, scored.warnings.length);
    assert.ok(Array.isArray(computeAlphaScore(pair, none).warnings));
    assert.ok(scored.warnings.some((x) => x.startsWith("Security DANGER")));
  });
});

describe("holder concentration excludes liquidity pools", () => {
  it("RugCheck: ignores AMM/locker accounts and market vaults but keeps the creator", () => {
    const report = {
      topHolders: [
        { address: "vault", owner: "market1", pct: 25.5 },
        { address: "ata2", owner: "ammAcct", pct: 10 },
        { address: "ata3", owner: "creatorWallet", pct: 8 },
        { address: "ata4", owner: "w4", pct: 4 },
        { address: "ata5", owner: "lockerAcct", pct: 6 },
      ],
      knownAccounts: { ammAcct: { name: "Pump Fun AMM", type: "AMM" }, lockerAcct: { type: "LOCKER" }, creatorWallet: { type: "CREATOR" } },
      markets: [{ pubkey: "market1" }],
    };
    const c = holderConcentration(report);
    assert.equal(c.excluded, 3);
    assert.equal(c.top, 8);
    assert.equal(c.top10, 12);
    const r = classifyRugCheck("MINT", { score_normalised: 3 }, { ...report, mintAuthority: null, freezeAuthority: null });
    assert.equal(r.topHolderPct, 8);
    assert.ok(!r.flags.some((f) => /Top holder owns/.test(f)), "pool vault must not trigger a whale flag");
  });

  it("RugCheck: no usable holders -> undefined (not 0)", () => {
    assert.deepEqual(holderConcentration({ topHolders: [] }), { excluded: 0 });
  });

  it("GoPlus: computes wallet concentration from non-contract holders only", () => {
    const entry = {
      is_honeypot: "0", buy_tax: "0", sell_tax: "0", cannot_sell_all: "0", owner_change_balance: "0", is_open_source: "1",
      holders: [
        { address: "0xpool", percent: "0.60", is_contract: 1 },
        { address: "0xa", percent: "0.20", is_contract: 0 },
        { address: "0xb", percent: "0.10", is_contract: 0 },
      ],
    };
    const r = classifyGoPlus("base", "0x1", entry);
    assert.equal(r.topHolderPct, 20);
    assert.equal(r.top10HolderPct, 30);
  });
});
