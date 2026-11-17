import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buyRatio,
  computeAlphaScore,
  detectBreakout,
  liquidityScore,
  pressureScore,
  securityAdjustment,
  socialScore,
  velocityScore,
  volumeVelocity,
} from "../../mcp-server/src/scoring.js";
import type { Catalysts, SecurityReport } from "../../mcp-server/src/types.js";
import { makePair } from "../helpers.js";

const none: Catalysts = { boosted: false, cto: false };
const sec = (status: SecurityReport["status"]): SecurityReport => ({ status, chainId: "solana", address: "x", source: "rugcheck", verdict: `${status} verdict`, flags: [] });

describe("liquidity health (0-25)", () => {
  it("penalises < $10k liquidity", () => {
    const thin = liquidityScore(makePair({ liquidity: { usd: 4_000 }, fdv: 100_000 }));
    const ok = liquidityScore(makePair({ liquidity: { usd: 60_000 }, fdv: 600_000 }));
    assert.ok(thin.points < 5, `thin=${thin.points}`);
    assert.ok(ok.points > 15, `ok=${ok.points}`);
    assert.ok(thin.reasons.some((r) => /Thin liquidity/.test(r)));
  });

  it("rewards depth relative to FDV and flags fragile pools", () => {
    const deep = liquidityScore(makePair({ liquidity: { usd: 100_000 }, fdv: 500_000 })).points;
    const fragile = liquidityScore(makePair({ liquidity: { usd: 100_000 }, fdv: 50_000_000 })).points;
    assert.ok(deep > fragile);
    assert.ok(liquidityScore(makePair({ liquidity: { usd: 100_000 }, fdv: 50_000_000 })).reasons.some((r) => /fragile/.test(r)));
  });

  it("is capped at 25", () => {
    assert.equal(liquidityScore(makePair({ liquidity: { usd: 5_000_000 }, fdv: 10_000_000 })).points, 25);
  });
});

describe("buy/sell pressure (0-25)", () => {
  it("rewards organic buy dominance above 60% and scales to the cap", () => {
    const strong = pressureScore(makePair({ txns: { m5: { buys: 40, sells: 10 }, h1: { buys: 400, sells: 100 } } }));
    assert.ok(strong.points >= 24 && strong.points <= 25, `${strong.points}`);
    assert.ok(strong.reasons.some((r) => /buy dominance/.test(r)));
  });

  it("scores zero when sells dominate", () => {
    const weak = pressureScore(makePair({ txns: { m5: { buys: 5, sells: 20 }, h1: { buys: 100, sells: 300 } } }));
    assert.equal(weak.points, 0);
    assert.ok(weak.reasons.some((r) => /sell pressure/.test(r)));
  });

  it("discounts tiny samples", () => {
    const tiny = pressureScore(makePair({ txns: { m5: { buys: 2, sells: 0 }, h1: { buys: 3, sells: 0 } } }));
    const big = pressureScore(makePair({ txns: { m5: { buys: 50, sells: 0 }, h1: { buys: 500, sells: 0 } } }));
    assert.ok(tiny.points < big.points / 3, `tiny=${tiny.points} big=${big.points}`);
  });

  it("handles missing data without NaN", () => {
    const p = pressureScore(makePair({ txns: undefined }));
    assert.equal(p.points, 0);
  });

  it("buyRatio divides buys by total", () => {
    assert.equal(buyRatio(75, 25), 0.75);
    assert.equal(buyRatio(0, 0), undefined);
  });
});

describe("volume velocity (0-25)", () => {
  it("computes turnover and 5m acceleration (m5*12 vs h1)", () => {
    const v = volumeVelocity(makePair({ liquidity: { usd: 50_000 }, volume: { m5: 10_000, h1: 60_000 } }));
    assert.equal(v.turnover, 1.2);
    assert.equal(v.acceleration, 2);
  });

  it("maxes out for high turnover and 2x acceleration", () => {
    const s = velocityScore(makePair({ liquidity: { usd: 10_000 }, volume: { m5: 6_000, h1: 30_000 } }));
    assert.equal(s.points, 25);
  });

  it("gives nothing for a dead pool", () => {
    assert.equal(velocityScore(makePair({ volume: { m5: 0, h1: 0 } })).points, 0);
  });

  it("only gives acceleration points when m5*12 exceeds the 1h pace", () => {
    const flat = velocityScore(makePair({ liquidity: { usd: 1_000_000 }, volume: { m5: 100, h1: 1200 } })); // accel = 1.0
    const hot = velocityScore(makePair({ liquidity: { usd: 1_000_000 }, volume: { m5: 200, h1: 1200 } })); // accel = 2.0
    assert.ok(hot.points > flat.points);
  });
});

describe("socials & catalysts (0-15)", () => {
  it("awards 3 points per signal up to 15", () => {
    const all = socialScore(makePair({ boosts: { active: 5 } }), { boosted: true, cto: true });
    assert.equal(all.points, 15);
    assert.equal(socialScore(makePair({ info: {} }), none).points, 0);
    assert.equal(socialScore(makePair(), none).points, 9);
  });

  it("treats pair-level active boosts as a catalyst", () => {
    assert.equal(socialScore(makePair({ info: {}, boosts: { active: 1 } }), none).points, 3);
  });
});

describe("security multiplier / veto", () => {
  it("DANGER rejects and subtracts 50", () => {
    const base = computeAlphaScore(makePair(), none).alphaScore;
    const danger = computeAlphaScore(makePair(), none, sec("DANGER"));
    assert.equal(danger.rejected, true);
    assert.equal(danger.breakdown.securityAdjustment, -50);
    assert.equal(danger.alphaScore, Math.max(0, Math.round((base - 50) * 10) / 10));
    assert.ok(danger.reasons.some((r) => r.startsWith("REJECTED")));
  });

  it("only a verified SAFE audit earns the +10 bonus; UNVERIFIED never does (fail-closed)", () => {
    assert.equal(securityAdjustment(sec("SAFE")).delta, 10);
    assert.equal(securityAdjustment(sec("UNVERIFIED")).delta, 0);
    assert.equal(securityAdjustment(sec("UNVERIFIED")).rejected, false);
    assert.equal(securityAdjustment(sec("WARNING")).delta, -5);
    assert.equal(securityAdjustment(null).delta, 0);
    const safe = computeAlphaScore(makePair(), none, sec("SAFE")).alphaScore;
    const unverified = computeAlphaScore(makePair(), none, sec("UNVERIFIED")).alphaScore;
    assert.ok(safe > unverified);
  });
});

describe("computeAlphaScore", () => {
  it("is deterministic and bounded to 0-100", () => {
    const p = makePair();
    assert.deepEqual(computeAlphaScore(p, none, sec("SAFE")), computeAlphaScore(p, none, sec("SAFE")));
    const best = computeAlphaScore(
      makePair({ liquidity: { usd: 2_000_000 }, fdv: 5_000_000, txns: { m5: { buys: 90, sells: 10 }, h1: { buys: 900, sells: 100 } }, volume: { m5: 1_500_000, h1: 6_000_000 }, boosts: { active: 3 } }),
      { boosted: true, cto: true },
      sec("SAFE"),
    );
    assert.equal(best.alphaScore, 100);
    const worst = computeAlphaScore(makePair({ liquidity: { usd: 100 }, txns: undefined, volume: undefined, info: {} }), none, sec("DANGER"));
    assert.equal(worst.alphaScore, 0);
  });

  it("breakdown components sum to the score before clamping", () => {
    const s = computeAlphaScore(makePair(), none, sec("SAFE"));
    const b = s.breakdown;
    assert.ok(Math.abs(b.liquidity + b.pressure + b.velocity + b.social + b.securityAdjustment - s.alphaScore) < 0.2);
    assert.ok(b.liquidity <= 25 && b.pressure <= 25 && b.velocity <= 25 && b.social <= 15);
  });

  it("ranks a strong setup above a weak one", () => {
    const strong = computeAlphaScore(makePair(), none, sec("SAFE")).alphaScore;
    const weak = computeAlphaScore(makePair({ liquidity: { usd: 6_000 }, txns: { m5: { buys: 2, sells: 9 }, h1: { buys: 40, sells: 90 } }, volume: { m5: 10, h1: 3_000 }, info: {} }), none, sec("SAFE")).alphaScore;
    assert.ok(strong > weak + 30, `strong=${strong} weak=${weak}`);
  });
});

describe("detectBreakout", () => {
  it("flags a 5m volume surge with buy dominance", () => {
    const s = detectBreakout(makePair({ volume: { m5: 20_000, h1: 60_000 }, txns: { m5: { buys: 40, sells: 10 }, h1: { buys: 100, sells: 90 } }, priceChange: { m5: 6 } }));
    assert.equal(s.isBreakout, true);
    assert.equal(s.acceleration, 4);
    assert.ok(s.breakoutScore > 50);
  });

  it("does not flag volume spikes driven by sells or falling price", () => {
    const sells = detectBreakout(makePair({ volume: { m5: 20_000, h1: 60_000 }, txns: { m5: { buys: 10, sells: 40 } } }));
    assert.equal(sells.isBreakout, false);
    const falling = detectBreakout(makePair({ volume: { m5: 20_000, h1: 60_000 }, priceChange: { m5: -4 } }));
    assert.equal(falling.isBreakout, false);
  });

  it("does not flag steady volume and respects custom thresholds", () => {
    const steady = makePair({ volume: { m5: 5_000, h1: 60_000 } }); // accel = 1
    assert.equal(detectBreakout(steady).isBreakout, false);
    assert.equal(detectBreakout(steady, { minAcceleration: 0.5 }).isBreakout, true);
  });

  it("ignores statistically meaningless activity", () => {
    const s = detectBreakout(makePair({ volume: { m5: 900, h1: 1_000 }, txns: { m5: { buys: 3, sells: 0 } } }));
    assert.equal(s.isBreakout, false);
  });
});
