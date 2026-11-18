import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DexScreenerClient } from "../../mcp-server/src/dexscreener.js";
import { SecurityAuditor } from "../../mcp-server/src/security.js";
import { ageWindow, analyzeJournal, analyzeTradeJournal } from "../../mcp-server/src/tools/trade-journal.js";
import { TradeLedger, type ExitReason, type Position } from "../../mcp-server/src/trading/ledger.js";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const freshLedger = () => {
  const d = mkdtempSync(join(tmpdir(), "dar-journal-"));
  dirs.push(d);
  return new TradeLedger(join(d, "trades.json"));
};

interface T {
  pnl: number;
  chain?: string;
  age?: number | null;
  alpha?: number;
  hw?: number;
  lw?: number;
  reason?: ExitReason;
  mode?: "paper" | "live";
  passed?: boolean;
  at?: string;
  size?: number;
}

function addClosed(l: TradeLedger, t: T): Position {
  const size = t.size ?? 100;
  const pnlUsd = (size * t.pnl) / 100;
  return l.add({
    mode: t.mode ?? "paper",
    status: "closed",
    chain: t.chain ?? "solana",
    tokenAddress: `T${Math.random()}`,
    symbol: "TKN",
    pairAddress: "P",
    openedAt: t.at ?? "2026-11-18T10:00:00.000Z",
    sizeUsd: size,
    entryFeesUsd: 0,
    tokenQty: 1,
    entryRefPriceUsd: 1,
    entryPriceUsd: 1,
    slippageBps: 200,
    priorityFeeLamports: 0,
    fillSource: "model",
    entryLiquidityUsd: 1,
    entry: { ageMinutes: t.age === undefined ? 3 : t.age, alphaScore: t.alpha ?? 75, security: "SAFE", forensics: "CLEAN_DISTRIBUTION", holderSafetyScore: 90, copycatRisk: "NONE", rulesEnforced: t.passed !== false, rulesPassed: t.passed !== false },
    highWaterPct: t.hw ?? Math.max(0, t.pnl),
    lowWaterPct: t.lw ?? Math.min(0, t.pnl),
    breakEvenArmed: false,
    exit: { at: "2026-11-18T11:00:00.000Z", priceUsd: 1, refPriceUsd: 1, reason: t.reason ?? "MANUAL", feesUsd: 0, pnlUsd, pnlPct: t.pnl, fillSource: "model" },
  });
}

describe("journal statistics", () => {
  it("handles an empty ledger and open-only ledgers helpfully", () => {
    const l = freshLedger();
    const empty: any = analyzeJournal(l);
    assert.equal(empty.closedTrades, 0);
    assert.match(empty.message, /no closed trades/);
    l.add({ ...(addClosed(freshLedger(), { pnl: 1 }) as Omit<Position, "id">), status: "open", exit: undefined });
    const open: any = analyzeJournal(l);
    assert.match(open.message, /1 open/);
  });

  it("computes win rate, net/average/median PnL, win/loss averages and profit factor exactly", () => {
    const l = freshLedger();
    for (const pnl of [50, 20, -10, -30, 100, -5]) addClosed(l, { pnl });
    const j: any = analyzeJournal(l);
    const s = j.summary;
    assert.equal(j.closedTrades, 6);
    assert.equal(s.wins, 3);
    assert.equal(s.losses, 3);
    assert.equal(s.winRatePct, 50);
    assert.equal(s.netPnlUsd, 125); // $100 positions: 50+20-10-30+100-5
    assert.equal(s.netPnlPct, 20.83); // 125 / 600
    assert.equal(s.avgPnlPct, 20.83);
    assert.equal(s.medianPnlPct, 7.5);
    assert.equal(s.avgWinPct, 56.67);
    assert.equal(s.avgLossPct, -15);
    assert.equal(s.profitFactor, 3.78); // 170 / 45
    assert.equal(j.bestTrades[0].pnlPct, 100);
    assert.equal(j.worstTrades[0].pnlPct, -30);
  });

  it("finds the best chain and the best launch-age window, flagging thin samples", () => {
    const l = freshLedger();
    for (const pnl of [40, 30, 50, -10, 20, 35]) addClosed(l, { pnl, chain: "solana", age: 2.5 }); // 2-5 min
    for (const pnl of [-20, -15, -30, 5, -10, -25]) addClosed(l, { pnl, chain: "base", age: 45 }); // 15-60 min
    addClosed(l, { pnl: 400, chain: "bsc", age: null }); // a single lucky trade
    const j: any = analyzeJournal(l);
    assert.equal(j.bestChain.chain, "bsc", "the highest average wins, but the thin sample is flagged");
    assert.equal(j.bestChain.sampleSizeOk, false);
    const solana = j.byChain.find((c: any) => c.chain === "solana");
    assert.equal(solana.winRatePct, 83.33);
    assert.equal(solana.sampleSizeOk, true);
    const best = j.byLaunchAge.find((w: any) => w.window === "2-5 min");
    assert.equal(best.trades, 6);
    assert.equal(best.avgPnlPct, 27.5);
    assert.deepEqual(j.byLaunchAge.map((w: any) => w.window).sort(), ["15-60 min", "2-5 min", "unknown"]);
    assert.equal(j.byExitReason[0].reason, "MANUAL");
  });

  it("buckets launch age", () => {
    assert.equal(ageWindow(0.5), "<=2 min");
    assert.equal(ageWindow(2), "<=2 min");
    assert.equal(ageWindow(3), "2-5 min");
    assert.equal(ageWindow(5), "2-5 min");
    assert.equal(ageWindow(14), "5-15 min");
    assert.equal(ageWindow(200), "1-6 h");
    assert.equal(ageWindow(1000), "6-24 h");
    assert.equal(ageWindow(99999), ">24 h");
    assert.equal(ageWindow(null), "unknown");
  });

  it("filters by mode, date and rule compliance", () => {
    const l = freshLedger();
    addClosed(l, { pnl: 10, mode: "paper", at: "2026-11-01T00:00:00Z" });
    addClosed(l, { pnl: 20, mode: "paper", at: "2026-11-18T00:00:00Z" });
    addClosed(l, { pnl: -50, mode: "paper", at: "2026-11-18T00:00:00Z", passed: false });
    addClosed(l, { pnl: 99, mode: "live", at: "2026-11-18T00:00:00Z" });
    assert.equal((analyzeJournal(l) as any).closedTrades, 3);
    assert.equal((analyzeJournal(l, { mode: "live" }) as any).closedTrades, 1);
    assert.equal((analyzeJournal(l, { mode: "all" }) as any).closedTrades, 4);
    assert.equal((analyzeJournal(l, { since: "2026-11-10" }) as any).closedTrades, 2);
    const strict: any = analyzeJournal(l, { onlyRuleCompliant: true });
    assert.equal(strict.closedTrades, 2);
    assert.equal(strict.ruleBypassedTrades, 1);
    assert.throws(() => analyzeJournal(l, { since: "not a date" }), /ISO date/);
  });

  it("the tool wrapper reads the ledger from deps", async () => {
    const l = freshLedger();
    addClosed(l, { pnl: 12 });
    const o = { fetchImpl: (async () => new Response("{}")) as typeof fetch };
    const j: any = await analyzeTradeJournal({ dex: new DexScreenerClient(o), security: new SecurityAuditor(o), ledger: l });
    assert.equal(j.closedTrades, 1);
  });
});

describe("threshold optimisation", () => {
  const trades = (rows: T[]) => {
    const l = freshLedger();
    rows.forEach((r) => addClosed(l, r));
    return l;
  };
  const sug = (j: any, parameter: string) => j.optimizations.find((o: any) => o.parameter === parameter);

  it("does not suggest anything below the minimum sample", () => {
    const j: any = analyzeJournal(trades([{ pnl: 40 }, { pnl: -30 }, { pnl: 10 }]));
    assert.deepEqual(j.optimizations, []);
    assert.match(j.optimizationNote, /Need at least 5 closed trades/);
  });

  it("suggests a higher Alpha minimum when low-alpha entries are the losers", () => {
    const l = trades([
      ...[70, 71, 72, 73, 74].map((alpha) => ({ pnl: -30, alpha })),
      ...[80, 82, 85, 88, 90].map((alpha) => ({ pnl: 40, alpha })),
    ]);
    const j: any = analyzeJournal(l);
    const s = sug(j, "minAlphaScore");
    assert.ok(s, JSON.stringify(j.optimizations));
    assert.equal(s.current, 70);
    assert.equal(s.suggested, 75);
    assert.equal(s.improvementPctPoints, 150); // 200 kept vs 50 summed at the current threshold
    assert.equal(s.tradesAffected, 5);
    assert.match(s.evidence, /Alpha >= 75/);
    assert.equal(s.confidence, "low", "10 trades is under 3x the minimum sample");
  });

  it("suggests a lower take-profit when trades reached it then faded", () => {
    const l = trades(Array.from({ length: 6 }, () => ({ pnl: -10, hw: 60, lw: -12, reason: "BREAK_EVEN_STOP" as const })));
    const s = sug(analyzeJournal(l), "takeProfitPct");
    assert.equal(s.suggested, 50);
    assert.equal(s.current, 100);
    assert.ok(s.improvementPctPoints >= 300);
  });

  it("suggests a tighter stop-loss when winners never dipped that far but losers ran to -30%", () => {
    const l = trades([
      ...Array.from({ length: 3 }, () => ({ pnl: 40, hw: 45, lw: -8 })),
      ...Array.from({ length: 3 }, () => ({ pnl: -30, hw: 5, lw: -31, reason: "STOP_LOSS" as const })),
    ]);
    const s = sug(analyzeJournal(l), "stopLossPct");
    assert.equal(s.suggested, -10);
    assert.equal(s.improvementPctPoints, 60);
  });

  it("suggests widening the entry window when the best trades came just outside it", () => {
    const l = trades([
      ...Array.from({ length: 6 }, (_, i) => ({ pnl: 50 + i, age: 10 + i, passed: false })), // 10-15 min winners (bypassed the 5 min rule)
      ...Array.from({ length: 6 }, (_, i) => ({ pnl: -20 - i, age: 3 + (i % 2) })), // inside 5 min, losing
    ]);
    const s = sug(analyzeJournal(l), "maxAgeMinutes");
    assert.ok(s);
    assert.equal(s.current, 5);
    assert.equal(s.suggested, 15);
    assert.ok(s.improvementPctPoints > 300);
  });

  it("suggests tightening the entry window when only the freshest launches won", () => {
    const l = trades([
      ...Array.from({ length: 5 }, () => ({ pnl: 40, age: 1.5 })),
      ...Array.from({ length: 5 }, () => ({ pnl: -20, age: 4 })),
    ]);
    const s = sug(analyzeJournal(l), "maxAgeMinutes");
    assert.equal(s.suggested, 2);
    assert.equal(s.improvementPctPoints, 100); // +200 kept vs +100 over the current window
  });

  it("makes no age suggestion when the current window is already best", () => {
    const l = trades([...Array.from({ length: 6 }, (_, i) => ({ pnl: 30 + i, age: 3 })), ...Array.from({ length: 6 }, (_, i) => ({ pnl: -20 - i, age: 60 + i, passed: false }))]);
    assert.equal(sug(analyzeJournal(l), "maxAgeMinutes"), undefined);
  });

  it("stays quiet when no change improves the result meaningfully", () => {
    const l = trades(Array.from({ length: 8 }, (_, i) => ({ pnl: i % 2 ? 12 : -4, hw: i % 2 ? 15 : 2, lw: i % 2 ? -2 : -5 })));
    const j: any = analyzeJournal(l);
    assert.deepEqual(j.optimizations, []);
    assert.match(j.optimizationNote, /No threshold change improves/);
  });

  it("never reports a candidate that leaves under minSample trades, and confidence grows with the sample", () => {
    const rows = [
      ...[70, 71, 72, 73, 74].map((alpha) => ({ pnl: -30, alpha })),
      ...[80, 82, 85, 88, 90].map((alpha) => ({ pnl: 40, alpha })),
    ];
    const strict: any = analyzeJournal(trades(rows), { minSample: 8 });
    assert.ok(!sug(strict, "minAlphaScore"), "raising Alpha would leave only 5 trades (< 8): not enough evidence");
    assert.equal(sug(analyzeJournal(trades(rows), { minSample: 2 }), "minAlphaScore").confidence, "medium");
    const big = trades([...Array.from({ length: 30 }, (_, i) => ({ pnl: -30, alpha: 70 + (i % 5) })), ...Array.from({ length: 30 }, (_, i) => ({ pnl: 40, alpha: 80 + (i % 10) }))]);
    assert.equal(sug(analyzeJournal(big), "minAlphaScore").confidence, "high");
  });

  it("always reports the thresholds currently in force", () => {
    const j: any = analyzeJournal(trades([{ pnl: 1 }]));
    assert.deepEqual(
      { a: j.currentThresholds.minAlphaScore, b: j.currentThresholds.maxAgeMinutes, tp: j.currentThresholds.takeProfitPct, sl: j.currentThresholds.stopLossPct },
      { a: 70, b: 5, tp: 100, sl: -30 },
    );
  });
});
