import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DexScreenerClient } from "../../mcp-server/src/dexscreener.js";
import { SecurityAuditor } from "../../mcp-server/src/security.js";
import { auditTokenSecurity, compareWatchlist, detectMomentumBreakouts, inspectToken, scanOpportunities, type ToolDeps } from "../../mcp-server/src/tools.js";
import { probeNetwork } from "./live.js";

const skip = await probeNetwork();
const WSOL = "So11111111111111111111111111111111111111112";

describe("end-to-end tools against live APIs", { skip }, () => {
  const deps: ToolDeps = { dex: new DexScreenerClient(), security: new SecurityAuditor() };

  it("scan_opportunities returns ranked, audited, scored results", async () => {
    const r = await scanOpportunities(deps, { chain: "solana", limit: 5, minLiquidityUsd: 5_000, maxAgeHours: 24 * 30 });
    assert.ok(r.stats.candidates > 0);
    assert.ok(r.results.length <= 5);
    let prev = Infinity;
    for (const x of r.results) {
      assert.ok(x.alphaScore >= 0 && x.alphaScore <= 100);
      assert.ok(x.alphaScore <= prev, "sorted by alpha score");
      prev = x.alphaScore;
      assert.ok(x.url.startsWith("https://dexscreener.com/"));
      assert.ok(["SAFE", "WARNING", "DANGER", "UNVERIFIED"].includes(x.security.status));
      assert.equal(x.rejected, x.security.status === "DANGER");
      assert.ok(!x.rejected, "DANGER hidden by default");
    }
  });

  it("inspect_token resolves SOL by symbol and by contract address", async () => {
    const bySymbol = await inspectToken(deps, { query: "SOL", chain: "solana" });
    assert.equal(bySymbol.found, true);
    const byCa = await inspectToken(deps, { query: WSOL });
    assert.ok(byCa.found);
    if (!byCa.found) return;
    assert.equal(byCa.token.tokenAddress, WSOL);
    assert.equal(typeof byCa.token.priceUsd, "string");
    assert.ok(byCa.pools.length > 0);
    assert.ok(byCa.token.security.status !== undefined);
  });

  it("audit_token_security returns a verdict", async () => {
    const r = await auditTokenSecurity(deps, { chain: "solana", address: WSOL });
    assert.ok(r.verdict.length > 0);
    assert.ok(["SAFE", "WARNING", "DANGER", "UNVERIFIED"].includes(r.status));
  });

  it("detect_momentum_breakouts returns a well-formed payload", async () => {
    const r = await detectMomentumBreakouts(deps, { chain: "solana", limit: 5 });
    assert.ok(Array.isArray(r.results));
    for (const x of r.results) assert.equal(x.breakout.isBreakout, true);
  });

  it("compare_watchlist ranks Solana tokens in one batched call", async () => {
    const boosted = (await deps.dex.boostsLatest()).filter((b) => b.chainId === "solana").slice(0, 4).map((b) => ({ address: b.tokenAddress }));
    const r = await compareWatchlist(deps, { tokens: [{ address: WSOL }, ...boosted] });
    assert.ok(r.ranking.length >= 1);
    for (let i = 1; i < r.ranking.length; i++) {
      const a = r.ranking[i - 1]!;
      const b = r.ranking[i]!;
      assert.ok(Number(a.rejected) <= Number(b.rejected));
    }
  });
});

describe("anti-wash filters and optional browser trending against live APIs", { skip }, () => {
  const deps: ToolDeps = { dex: new DexScreenerClient(), security: new SecurityAuditor() };

  it("scan_opportunities on base returns a well-formed (possibly small) payload", async () => {
    const r = await scanOpportunities(deps, { chain: "base", limit: 5, minLiquidityUsd: 5_000, maxAgeHours: 24 * 60 });
    assert.ok(Array.isArray(r.results));
    for (const x of r.results) {
      assert.equal(x.chain, "base");
      assert.ok(["SAFE", "WARNING", "DANGER", "UNVERIFIED"].includes(x.security.status));
    }
  });

  it("every live candidate carries a warnings array, trade-quality stats and a numeric penalty", async () => {
    const r = await scanOpportunities(deps, { chain: "solana", limit: 6, minLiquidityUsd: 5_000, maxAgeHours: 24 * 30 });
    assert.ok(r.results.length > 0);
    for (const x of r.results) {
      assert.ok(Array.isArray(x.warnings) && x.warnings.every((w) => typeof w === "string"));
      assert.equal(typeof x.scoreBreakdown.manipulationPenalty, "number");
      assert.ok(x.scoreBreakdown.manipulationPenalty <= 0 && x.scoreBreakdown.manipulationPenalty >= -20);
      assert.equal(typeof x.tradeQuality.washSuspected, "boolean");
      if (x.tradeQuality.washSuspected) assert.ok(x.warnings.some((w) => /bot volume|wash trading/.test(w)));
    }
  });

  it("useBrowserTrending never breaks the scan: results come back with an honest trending status", { timeout: 120_000 }, async () => {
    const r = await scanOpportunities(deps, { chain: "solana", limit: 3, useBrowserTrending: true, minLiquidityUsd: 5_000, maxAgeHours: 24 * 30 });
    assert.ok(r.trending, "trending info is reported when requested");
    assert.ok(["ok", "empty", "blocked", "unavailable", "error"].includes(r.trending.status));
    assert.ok(r.results.length > 0, "API sources still produce results when the browser is blocked");
    if (r.trending.status !== "ok") assert.ok(r.warnings.some((w) => w === r.trending!.message));
  });
});
