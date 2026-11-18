/**
 * analyze_trade_journal: performance statistics and threshold optimisation from the trade ledger.
 *
 * The optimiser replays closed trades under alternative thresholds using what the ledger
 * recorded (entry snapshot, high-water / low-water marks). That is IN-SAMPLE analysis on a
 * small sample, so suggestions need a minimum number of trades, carry a confidence label,
 * and are never applied automatically. Marks are only observed when the guard runs, so
 * intra-interval extremes are not captured.
 */
import { ENTRY_RULES, GUARD } from "../trading/guard.js";
import type { Position, TradeLedger, TradeMode } from "../trading/ledger.js";
import { DISCLAIMER, type ToolDeps } from "./index.js";
import { getLedger } from "./paper-phantom-trader.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface JournalParams {
  mode?: TradeMode | "all";
  /** ISO date/time: only trades opened on or after it. */
  since?: string;
  /** Minimum trades before a statistic or suggestion is considered meaningful. Default 5. */
  minSample?: number;
  /** Exclude trades that bypassed the entry rules. */
  onlyRuleCompliant?: boolean;
}

interface Trade {
  pos: Position;
  pnlPct: number;
  pnlUsd: number;
  win: boolean;
}

const toTrades = (positions: Position[]): Trade[] =>
  positions
    .filter((p) => p.status === "closed" && p.exit)
    .map((p) => ({ pos: p, pnlPct: p.exit!.pnlPct, pnlUsd: p.exit!.pnlUsd, win: p.exit!.pnlUsd > 0 }));

function summarize(trades: Trade[]) {
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const grossWin = sum(wins.map((t) => t.pnlUsd));
  const grossLoss = Math.abs(sum(losses.map((t) => t.pnlUsd)));
  const cost = sum(trades.map((t) => t.pos.sizeUsd + t.pos.entryFeesUsd));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? r2((wins.length / trades.length) * 100) : null,
    netPnlUsd: r2(sum(trades.map((t) => t.pnlUsd))),
    netPnlPct: cost > 0 ? r2((sum(trades.map((t) => t.pnlUsd)) / cost) * 100) : null,
    avgPnlPct: trades.length ? r2(mean(trades.map((t) => t.pnlPct))) : null,
    medianPnlPct: trades.length ? r2(median(trades.map((t) => t.pnlPct))) : null,
    avgWinPct: wins.length ? r2(mean(wins.map((t) => t.pnlPct))) : null,
    avgLossPct: losses.length ? r2(mean(losses.map((t) => t.pnlPct))) : null,
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null, // null: no losing trades yet
    totalFeesUsd: r2(sum(trades.map((t) => t.pos.entryFeesUsd + (t.pos.exit?.feesUsd ?? 0)))),
  };
}

// ----- launch-age windows -----

export const AGE_WINDOWS: { label: string; maxMinutes: number }[] = [
  { label: "<=2 min", maxMinutes: 2 },
  { label: "2-5 min", maxMinutes: 5 },
  { label: "5-15 min", maxMinutes: 15 },
  { label: "15-60 min", maxMinutes: 60 },
  { label: "1-6 h", maxMinutes: 360 },
  { label: "6-24 h", maxMinutes: 1440 },
  { label: ">24 h", maxMinutes: Infinity },
];

export function ageWindow(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "unknown";
  return AGE_WINDOWS.find((w) => minutes <= w.maxMinutes)!.label;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

// ----- optimisation -----

export interface Optimization {
  parameter: string;
  current: number;
  suggested: number;
  /** Sum of per-trade PnL% under the suggestion minus under the current setting (in-sample). */
  improvementPctPoints: number;
  tradesAffected: number;
  evidence: string;
  confidence: "low" | "medium" | "high";
}

const confidenceFor = (n: number, minSample: number): Optimization["confidence"] => (n >= 50 ? "high" : n >= minSample * 3 ? "medium" : "low");
const MIN_IMPROVEMENT = 10; // percentage points of summed PnL, to avoid chasing noise

interface Sweep {
  parameter: string;
  current: number;
  candidates: number[];
  /** PnL% each trade would have had under candidate `c`, or undefined if the trade would not have been taken. */
  outcome: (t: Trade, c: number) => number | undefined;
  describe: (best: number, kept: number, total: number, baseline: number) => string;
  /** Filters shrink the sample; exits keep every trade. */
  isFilter: boolean;
}

export function optimize(trades: Trade[], minSample: number): Optimization[] {
  if (trades.length < minSample) return [];
  const out: Optimization[] = [];
  const sweeps: Sweep[] = [
    {
      parameter: "minAlphaScore",
      current: ENTRY_RULES.minAlphaScore,
      candidates: [50, 55, 60, 65, 70, 75, 80, 85, 90],
      isFilter: true,
      outcome: (t, c) => (t.pos.entry.alphaScore >= c ? t.pnlPct : undefined),
      describe: (best, kept, total, base) => `Entering only at Alpha >= ${best} would have kept ${kept} of the trades and summed ${r2(total)}% vs ${r2(base)}% at the current threshold`,
    },
    {
      parameter: "maxAgeMinutes",
      current: ENTRY_RULES.maxAgeMinutes,
      candidates: [2, 3, 5, 10, 15, 30, 60, 180, 1440],
      isFilter: true,
      outcome: (t, c) => (t.pos.entry.ageMinutes !== null && t.pos.entry.ageMinutes <= c ? t.pnlPct : undefined),
      describe: (best, kept, total, base) => `Entering up to ${best} min after launch would have kept ${kept} trades and summed ${r2(total)}% vs ${r2(base)}% at the current window`,
    },
    {
      parameter: "takeProfitPct",
      current: GUARD.takeProfitPct,
      candidates: [30, 50, 75, 100, 150, 200],
      isFilter: false,
      outcome: (t, c) => (t.pos.highWaterPct >= c ? c : t.pnlPct),
      describe: (best, _k, total, base) => `A +${best}% take-profit would have summed ${r2(total)}% vs ${r2(base)}% (uses each trade's recorded high-water mark)`,
    },
    {
      parameter: "stopLossPct",
      current: GUARD.stopLossPct,
      candidates: [-10, -15, -20, -25, -30, -40, -50],
      isFilter: false,
      outcome: (t, c) => (t.pos.lowWaterPct <= c ? c : t.pnlPct),
      describe: (best, _k, total, base) => `A ${best}% stop loss would have summed ${r2(total)}% vs ${r2(base)}% (uses each trade's recorded low-water mark)`,
    },
    {
      parameter: "breakEvenTriggerPct",
      current: GUARD.breakEvenTriggerPct,
      candidates: [20, 30, 40, 50, 75],
      isFilter: false,
      outcome: (t, c) => (t.pos.highWaterPct >= c && t.pnlPct < 0 ? 0 : t.pnlPct),
      describe: (best, _k, total, base) => `Moving the stop to break-even at +${best}% would have summed ${r2(total)}% vs ${r2(base)}%`,
    },
  ];

  for (const s of sweeps) {
    const evalAt = (c: number) => {
      const kept = trades.map((t) => s.outcome(t, c)).filter((x): x is number => x !== undefined);
      return { n: kept.length, total: sum(kept) };
    };
    const base = evalAt(s.current);
    let best = { c: s.current, ...base };
    for (const c of s.candidates) {
      const e = evalAt(c);
      if (e.n < minSample) continue; // a threshold that leaves too few trades proves nothing
      if (e.total > best.total + 1e-9) best = { c, ...e };
    }
    if (best.c !== s.current && best.total - base.total >= MIN_IMPROVEMENT) {
      out.push({
        parameter: s.parameter,
        current: s.current,
        suggested: best.c,
        improvementPctPoints: r2(best.total - base.total),
        tradesAffected: s.isFilter ? Math.abs(base.n - best.n) : trades.filter((t) => s.outcome(t, best.c) !== s.outcome(t, s.current)).length,
        evidence: s.describe(best.c, best.n, best.total, base.total),
        confidence: confidenceFor(trades.length, minSample),
      });
    }
  }
  return out.sort((a, b) => b.improvementPctPoints - a.improvementPctPoints);
}

// ----- tool -----

export function analyzeJournal(ledger: TradeLedger, p: JournalParams = {}) {
  const mode = p.mode ?? "paper";
  const minSample = p.minSample ?? 5;
  const since = p.since ? Date.parse(p.since) : undefined;
  if (p.since && Number.isNaN(since)) throw new Error("since must be an ISO date, e.g. 2026-11-01");

  const all = ledger.list({ mode, since });
  const open = all.filter((x) => x.status === "open");
  let trades = toTrades(all);
  const bypassed = trades.filter((t) => !t.pos.entry.rulesPassed).length;
  if (p.onlyRuleCompliant) trades = trades.filter((t) => t.pos.entry.rulesPassed);

  if (!trades.length) {
    return {
      mode,
      openPositions: open.length,
      closedTrades: 0,
      message: open.length ? `No closed trades yet (${open.length} open). Run action=monitor on simulate_or_prepare_trade, or sell, to close them.` : "The ledger has no closed trades. Open some with simulate_or_prepare_trade (paperMode is the default).",
      disclaimer: DISCLAIMER,
    };
  }

  const summary = summarize(trades);
  const sorted = [...trades].sort((a, b) => b.pnlPct - a.pnlPct);
  const brief = (t: Trade) => ({ id: t.pos.id, symbol: t.pos.symbol, chain: t.pos.chain, pnlPct: r2(t.pnlPct), pnlUsd: r2(t.pnlUsd), exit: t.pos.exit!.reason, entryAgeMinutes: t.pos.entry.ageMinutes });

  const chains = [...groupBy(trades, (t) => t.pos.chain)].map(([chain, ts]) => ({ chain, ...summarize(ts), sampleSizeOk: ts.length >= minSample })).sort((a, b) => (b.avgPnlPct ?? -Infinity) - (a.avgPnlPct ?? -Infinity));
  const windows = AGE_WINDOWS.map((w) => w.label)
    .concat("unknown")
    .map((label) => ({ window: label, ts: trades.filter((t) => ageWindow(t.pos.entry.ageMinutes) === label) }))
    .filter((x) => x.ts.length)
    .map((x) => ({ window: x.window, ...summarize(x.ts), sampleSizeOk: x.ts.length >= minSample }))
    .sort((a, b) => (b.avgPnlPct ?? -Infinity) - (a.avgPnlPct ?? -Infinity));
  const exits = [...groupBy(trades, (t) => t.pos.exit!.reason)].map(([reason, ts]) => ({ reason, trades: ts.length, avgPnlPct: r2(mean(ts.map((t) => t.pnlPct))) }));

  const enough = trades.length >= minSample;
  const optimizations = optimize(trades, minSample);
  return {
    mode,
    since: p.since,
    openPositions: open.length,
    closedTrades: trades.length,
    ruleBypassedTrades: bypassed,
    summary,
    bestChain: chains[0] ? { chain: chains[0].chain, avgPnlPct: chains[0].avgPnlPct, trades: chains[0].trades, sampleSizeOk: chains[0].sampleSizeOk } : undefined,
    bestLaunchAgeWindow: windows[0] ? { window: windows[0].window, avgPnlPct: windows[0].avgPnlPct, winRatePct: windows[0].winRatePct, trades: windows[0].trades, sampleSizeOk: windows[0].sampleSizeOk } : undefined,
    byChain: chains,
    byLaunchAge: windows,
    byExitReason: exits,
    bestTrades: sorted.slice(0, 3).map(brief),
    worstTrades: sorted.slice(-3).reverse().map(brief),
    currentThresholds: { minAlphaScore: ENTRY_RULES.minAlphaScore, maxAgeMinutes: ENTRY_RULES.maxAgeMinutes, ...GUARD },
    optimizations,
    optimizationNote: enough
      ? optimizations.length
        ? "Suggestions are in-sample replays on a small sample: treat them as hypotheses, confirm on new trades, and change one threshold at a time."
        : "No threshold change improves the recorded trades by a meaningful margin."
      : `Need at least ${minSample} closed trades before suggesting threshold changes (have ${trades.length}).`,
    disclaimer: DISCLAIMER,
  };
}

export async function analyzeTradeJournal(deps: ToolDeps, p: JournalParams = {}) {
  return analyzeJournal(getLedger(deps), p);
}
