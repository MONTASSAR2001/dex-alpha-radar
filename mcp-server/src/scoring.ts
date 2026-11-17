import type { AlphaScore, Catalysts, DexPair, SecurityReport } from "./types.js";

/**
 * Deterministic Alpha Score (0-100). Every component is documented and capped:
 *   Liquidity health   0-25   depth (0-17) + liquidity/FDV ratio (0-8)
 *   Buy/sell pressure  0-25   5m buy ratio (0-12.5) + 1h buy ratio (0-12.5)
 *   Volume velocity    0-25   1h turnover (0-15) + 5m->1h acceleration (0-10)
 *   Socials/catalysts  0-15   website, X, Telegram, active boost, CTO (3 each)
 *   Manipulation       0 to -20 for bot / wash-trading signals (tiny avg trade size, extreme
 *                      volume-to-liquidity turnover with flat price)
 *   Security           verified SAFE +10 | WARNING -5 | UNVERIFIED 0 (no bonus: fail-closed)
 *                      DANGER -50 and REJECTED (hard veto)
 *   Max = 25 + 25 + 25 + 15 + 10 = 100
 */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const r1 = (n: number) => Math.round(n * 10) / 10;
/** Linear map of x from [a,b] to [c,d], clamped. */
const lerp = (x: number, a: number, b: number, c: number, d: number) => c + ((clamp(x, a, b) - a) / (b - a)) * (d - c);

export function liquidityScore(pair: DexPair): { points: number; reasons: string[] } {
  const liq = pair.liquidity?.usd ?? 0;
  const reasons: string[] = [];

  let depth: number;
  if (liq < 5_000) depth = 0;
  else if (liq < 10_000) depth = lerp(liq, 5_000, 10_000, 0, 4);
  else if (liq < 25_000) depth = lerp(liq, 10_000, 25_000, 4, 10);
  else if (liq < 100_000) depth = lerp(liq, 25_000, 100_000, 10, 14);
  else if (liq < 500_000) depth = lerp(liq, 100_000, 500_000, 14, 17);
  else depth = 17;
  if (liq < 10_000) reasons.push(`Thin liquidity $${fmt(liq)} (< $10k)`);
  else if (liq >= 25_000) reasons.push(`Healthy liquidity $${fmt(liq)}`);

  const cap = pair.fdv ?? pair.marketCap;
  let ratioPts: number;
  if (!cap || cap <= 0) {
    ratioPts = 3; // unknown valuation: neutral-low
  } else {
    const ratio = liq / cap;
    ratioPts = ratio >= 0.1 ? 8 : ratio >= 0.05 ? 6 : ratio >= 0.02 ? 4 : ratio >= 0.01 ? 2 : 0;
    if (ratio < 0.01) reasons.push(`Liquidity only ${(ratio * 100).toFixed(2)}% of FDV (fragile)`);
    else if (ratio >= 0.05) reasons.push(`Liquidity ${(ratio * 100).toFixed(1)}% of FDV`);
  }
  return { points: r1(clamp(depth + ratioPts, 0, 25)), reasons };
}

export function buyRatio(buys = 0, sells = 0): number | undefined {
  const total = buys + sells;
  return total > 0 ? buys / total : undefined;
}

export function pressureScore(pair: DexPair): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  const window = (w: "m5" | "h1", minTxns: number): number => {
    const t = pair.txns?.[w];
    const total = (t?.buys ?? 0) + (t?.sells ?? 0);
    const ratio = buyRatio(t?.buys, t?.sells);
    if (ratio === undefined) return 0;
    // 40% buys -> 0 pts, 75%+ -> 12.5 pts; thin samples are discounted.
    const raw = lerp(ratio, 0.4, 0.75, 0, 12.5);
    const confidence = clamp(total / minTxns, 0, 1);
    if (ratio > 0.6 && confidence >= 1) reasons.push(`${w} buy dominance ${(ratio * 100).toFixed(0)}% (${total} txns)`);
    else if (ratio < 0.45 && confidence >= 1) reasons.push(`${w} sell pressure: only ${(ratio * 100).toFixed(0)}% buys`);
    return raw * confidence;
  };
  const points = window("m5", 5) + window("h1", 20);
  return { points: r1(clamp(points, 0, 25)), reasons };
}

export function volumeVelocity(pair: DexPair): { turnover: number; acceleration: number } {
  const liq = pair.liquidity?.usd ?? 0;
  const h1 = pair.volume?.h1 ?? 0;
  const m5 = pair.volume?.m5 ?? 0;
  return { turnover: liq > 0 ? h1 / liq : 0, acceleration: h1 > 0 ? (m5 * 12) / h1 : 0 };
}

export function velocityScore(pair: DexPair): { points: number; reasons: string[] } {
  const { turnover, acceleration } = volumeVelocity(pair);
  const reasons: string[] = [];
  const turnPts = lerp(turnover, 0, 3, 0, 15);
  // m5*12 <= 0.5*h1 -> 0 pts; exactly in line (1.0x) -> 4 pts; 2x or more -> 10 pts.
  const accelPts = acceleration <= 1 ? lerp(acceleration, 0.5, 1, 0, 4) : lerp(acceleration, 1, 2, 4, 10);
  if (turnover >= 1) reasons.push(`1h volume is ${turnover.toFixed(1)}x liquidity`);
  if (acceleration > 1) reasons.push(`5m volume accelerating (${acceleration.toFixed(1)}x the 1h pace)`);
  return { points: r1(clamp(turnPts + accelPts, 0, 25)), reasons };
}

export function socialScore(pair: DexPair, catalysts: Catalysts): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  let pts = 0;
  const hasWebsite = (pair.info?.websites ?? []).some((w) => !!w.url);
  const socials = pair.info?.socials ?? [];
  const has = (...types: string[]) => socials.some((s) => !!s.url && types.includes((s.type ?? "").toLowerCase()));
  if (hasWebsite) {
    pts += 3;
    reasons.push("Website listed");
  }
  if (has("twitter", "x")) {
    pts += 3;
    reasons.push("X/Twitter listed");
  }
  if (has("telegram")) {
    pts += 3;
    reasons.push("Telegram listed");
  }
  if (catalysts.boosted || (pair.boosts?.active ?? 0) > 0) {
    pts += 3;
    reasons.push("Active DexScreener boost");
  }
  if (catalysts.cto) {
    pts += 3;
    reasons.push("Community takeover (CTO)");
  }
  return { points: pts, reasons };
}

export function securityAdjustment(security?: SecurityReport | null): { delta: number; rejected: boolean; reasons: string[] } {
  if (!security) return { delta: 0, rejected: false, reasons: [] };
  switch (security.status) {
    case "DANGER":
      return { delta: -50, rejected: true, reasons: [`REJECTED: security DANGER. ${security.verdict}`] };
    case "WARNING":
      return { delta: -5, rejected: false, reasons: [`Security warning. ${security.verdict}`] };
    case "UNVERIFIED":
      return { delta: 0, rejected: false, reasons: ["Security UNVERIFIED: no safety bonus (fail-closed, not treated as safe)"] };
    default:
      return { delta: 10, rejected: false, reasons: ["Security audit passed (SAFE)"] };
  }
}

// ---------------------------------------------------------------------------
// Anti-wash-trading
// ---------------------------------------------------------------------------

/** Average 1h trade below this (USD) with many transactions suggests bot / wash volume. */
export const MIN_AVG_TRADE_USD = 15;
/** Minimum 1h transactions for the avg-trade-size signal to count as "high activity". */
export const WASH_MIN_TXNS = 50;
/** 1h volume above this multiple of liquidity with flat price is a wash-trading signal. */
export const WASH_VOLUME_LIQ_MULTIPLE = 20;
/** |1h price change| (%) below this counts as "flat". */
export const WASH_FLAT_PRICE_PCT = 5;
export const MAX_MANIPULATION_PENALTY = 20;
/** Top-10 non-pool holder share (%) at or above which a concentration warning is raised. */
export const HOLDER_CONCENTRATION_WARN_PCT = 40;

export interface WashAnalysis {
  /** volume.h1 / (buys + sells) in the last hour. */
  avgTradeUsd: number | undefined;
  txns1h: number;
  /** volume.h1 / liquidity.usd. */
  volumeToLiquidity: number | undefined;
  /** Penalty in points (0..MAX_MANIPULATION_PENALTY), subtracted from the Alpha Score. */
  penalty: number;
  warnings: string[];
  /** True when any wash-trading signal fired. */
  suspected: boolean;
}

/**
 * DexScreener does not expose maker counts, so two proxies are used:
 *  1. average trade size: h1 volume / h1 txns, penalised when < $15 despite >= 50 txns
 *  2. volume sanity: h1 volume > 20x liquidity while price stayed flat
 */
export function analyzeWashTrading(pair: DexPair): WashAnalysis {
  const b = pair.txns?.h1?.buys ?? 0;
  const s = pair.txns?.h1?.sells ?? 0;
  const txns1h = b + s;
  const vol = pair.volume?.h1;
  const liq = pair.liquidity?.usd ?? 0;
  const warnings: string[] = [];
  let penalty = 0;

  const avgTradeUsd = vol !== undefined && txns1h > 0 ? vol / txns1h : undefined;
  if (avgTradeUsd !== undefined && txns1h >= WASH_MIN_TXNS && avgTradeUsd < MIN_AVG_TRADE_USD) {
    // $15 -> 0 pts, $1 or less -> 12 pts.
    penalty += lerp(avgTradeUsd, 1, MIN_AVG_TRADE_USD, 12, 0);
    warnings.push(`Low avg trade size ($${avgTradeUsd.toFixed(2)}) over ${txns1h} txns in 1h: possible bot volume`);
  }

  const volumeToLiquidity = vol !== undefined && liq > 0 ? vol / liq : undefined;
  const change1h = pair.priceChange?.h1;
  if (volumeToLiquidity !== undefined && volumeToLiquidity > WASH_VOLUME_LIQ_MULTIPLE && change1h !== undefined && Math.abs(change1h) < WASH_FLAT_PRICE_PCT) {
    penalty += 10;
    warnings.push(
      `1h volume is ${volumeToLiquidity.toFixed(1)}x liquidity with flat price (${change1h >= 0 ? "+" : ""}${change1h}%): possible wash trading`,
    );
  }

  return {
    avgTradeUsd: avgTradeUsd === undefined ? undefined : Math.round(avgTradeUsd * 100) / 100,
    txns1h,
    volumeToLiquidity: volumeToLiquidity === undefined ? undefined : r1(volumeToLiquidity),
    penalty: r1(Math.min(MAX_MANIPULATION_PENALTY, penalty)),
    warnings,
    suspected: warnings.length > 0,
  };
}

/** Actionable risk warnings for a candidate, most severe first. */
export function buildWarnings(pair: DexPair, wash: WashAnalysis, security?: SecurityReport | null, now = Date.now()): string[] {
  const out: string[] = [];
  if (security) {
    if (security.status === "DANGER") out.push(`Security DANGER: ${security.verdict}`);
    if (security.status === "UNVERIFIED") out.push("Security UNVERIFIED: no audit data, treat as unsafe");
    if (security.mintAuthorityActive) out.push("Mint authority is active: supply can be inflated");
    if (security.freezeAuthorityActive) out.push("Freeze authority is active: wallets can be frozen");
    if (security.isHoneypot) out.push("Honeypot detected: tokens cannot be sold");
    if (security.isOpenSource === false) out.push("Unverified contract: source code is not open/verified");
    for (const [label, tax] of [["Buy", security.buyTax], ["Sell", security.sellTax]] as const) {
      if (tax !== undefined && tax > 0.1) out.push(`${label} tax ${Math.round(tax * 1000) / 10}%`);
    }
    if (security.top10HolderPct !== undefined && security.top10HolderPct >= HOLDER_CONCENTRATION_WARN_PCT) {
      out.push(`High top-10 holder concentration (${Math.round(security.top10HolderPct)}%)`);
    } else if (security.topHolderPct !== undefined && security.topHolderPct >= 20) {
      out.push(`Single wallet holds ${Math.round(security.topHolderPct)}% of supply`);
    }
  }
  out.push(...wash.warnings);
  const liq = pair.liquidity?.usd ?? 0;
  if (liq < 10_000) out.push(`Thin liquidity ($${fmt(liq)})`);
  const cap = pair.fdv ?? pair.marketCap;
  if (cap && liq / cap < 0.01) out.push(`Liquidity is only ${((liq / cap) * 100).toFixed(2)}% of FDV: price can be moved easily`);
  const age = pairAgeHours(pair, now);
  if (age !== undefined && age < 1) out.push(`Very new pair (${Math.round(age * 60)} min old)`);
  return [...new Set(out)];
}

export function computeAlphaScore(pair: DexPair, catalysts: Catalysts, security?: SecurityReport | null, now = Date.now()): AlphaScore {
  const liq = liquidityScore(pair);
  const pres = pressureScore(pair);
  const vel = velocityScore(pair);
  const soc = socialScore(pair, catalysts);
  const sec = securityAdjustment(security);
  const wash = analyzeWashTrading(pair);
  const raw = liq.points + pres.points + vel.points + soc.points - wash.penalty + sec.delta;
  return {
    alphaScore: r1(clamp(raw, 0, 100)),
    rejected: sec.rejected,
    breakdown: {
      liquidity: liq.points,
      pressure: pres.points,
      velocity: vel.points,
      social: soc.points,
      manipulationPenalty: wash.penalty === 0 ? 0 : -wash.penalty,
      securityAdjustment: sec.delta,
    },
    reasons: [...liq.reasons, ...pres.reasons, ...vel.reasons, ...soc.reasons, ...sec.reasons],
    warnings: buildWarnings(pair, wash, security, now),
  };
}

// ---------------------------------------------------------------------------
// Momentum breakouts
// ---------------------------------------------------------------------------

export interface BreakoutSignal {
  isBreakout: boolean;
  /** (m5 volume * 12) / h1 volume. */
  acceleration: number;
  buyRatio5m: number | undefined;
  buyRatio1h: number | undefined;
  m5VolumeUsd: number;
  m5Txns: number;
  priceChangeM5: number;
  /** 0-100 strength of the breakout (not a safety score). */
  breakoutScore: number;
  /** Bot / wash-trading signals fired: such a surge is not counted as a breakout. */
  washSuspected: boolean;
}

export interface BreakoutThresholds {
  minAcceleration: number;
  minBuyRatio: number;
  minM5Txns: number;
  minM5VolumeUsd: number;
}

export const DEFAULT_BREAKOUT: BreakoutThresholds = {
  minAcceleration: 2,
  minBuyRatio: 0.6,
  minM5Txns: 8,
  minM5VolumeUsd: 1_000,
};

export function detectBreakout(pair: DexPair, t: Partial<BreakoutThresholds> = {}): BreakoutSignal {
  const th = { ...DEFAULT_BREAKOUT, ...t };
  const { acceleration } = volumeVelocity(pair);
  const m5 = pair.txns?.m5;
  const m5Txns = (m5?.buys ?? 0) + (m5?.sells ?? 0);
  const buyRatio5m = buyRatio(m5?.buys, m5?.sells);
  const buyRatio1h = buyRatio(pair.txns?.h1?.buys, pair.txns?.h1?.sells);
  const m5VolumeUsd = pair.volume?.m5 ?? 0;
  const priceChangeM5 = pair.priceChange?.m5 ?? 0;

  const washSuspected = analyzeWashTrading(pair).suspected;
  const isBreakout =
    !washSuspected &&
    acceleration >= th.minAcceleration &&
    (buyRatio5m ?? 0) >= th.minBuyRatio &&
    m5Txns >= th.minM5Txns &&
    m5VolumeUsd >= th.minM5VolumeUsd &&
    priceChangeM5 > 0;

  // Strength: acceleration (40) + 5m buy dominance (30) + activity depth (20) + price follow-through (10).
  const accelPts = lerp(acceleration, 1, 6, 0, 40);
  const buyPts = buyRatio5m === undefined ? 0 : lerp(buyRatio5m, 0.5, 0.85, 0, 30);
  const depthPts = lerp(m5Txns, 0, 60, 0, 20);
  const pricePts = lerp(priceChangeM5, 0, 10, 0, 10);
  return {
    isBreakout,
    acceleration: r1(acceleration),
    buyRatio5m: buyRatio5m === undefined ? undefined : Math.round(buyRatio5m * 1000) / 1000,
    buyRatio1h: buyRatio1h === undefined ? undefined : Math.round(buyRatio1h * 1000) / 1000,
    m5VolumeUsd,
    m5Txns,
    priceChangeM5,
    breakoutScore: r1(clamp(accelPts + buyPts + depthPts + pricePts, 0, 100)),
    washSuspected,
  };
}

export function pairAgeHours(pair: DexPair, now = Date.now()): number | undefined {
  return pair.pairCreatedAt ? Math.max(0, (now - pair.pairCreatedAt) / 3_600_000) : undefined;
}

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0);
}
