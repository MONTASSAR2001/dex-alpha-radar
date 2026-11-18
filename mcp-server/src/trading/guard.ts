/**
 * Pure trading rules: entry gate and the Trailing Profit Guard. No I/O.
 *
 * Entry (all must pass):  age <= 5 min | security SAFE | alpha >= 70 | holder forensics CLEAN
 *                         | no copycat flag (MEDIUM/HIGH)
 * Guard:  +50% -> stop moves to break-even (0%) | +100% -> take profit | -30% -> stop loss
 *         | liquidity down > 20% from entry -> emergency exit
 *
 * Exits are evaluated against the price observed when a position is checked. A price that
 * spikes and reverses between two checks can be missed: the guard is only as continuous as
 * its polling (the in-process monitor checks paper positions every 30 s by default).
 */
import type { ExitReason, Position } from "./ledger.js";

export const ENTRY_RULES = {
  maxAgeMinutes: 5,
  requiredSecurity: "SAFE",
  minAlphaScore: 70,
} as const;

export const GUARD = {
  takeProfitPct: 100,
  stopLossPct: -30,
  breakEvenTriggerPct: 50,
  breakEvenStopPct: 0,
  emergencyLiquidityDropPct: 20,
} as const;

export interface EntryContext {
  ageMinutes: number | null;
  security: string;
  alphaScore: number;
  forensicsVerdict: string;
  copycatRisk: string;
}

export interface RuleCheck {
  rule: string;
  passed: boolean;
  actual: string;
  required: string;
}

export interface EntryEvaluation {
  passed: boolean;
  checks: RuleCheck[];
  failed: string[];
}

export function evaluateEntryRules(c: EntryContext): EntryEvaluation {
  const checks: RuleCheck[] = [
    {
      rule: "age",
      passed: c.ageMinutes !== null && c.ageMinutes <= ENTRY_RULES.maxAgeMinutes,
      actual: c.ageMinutes === null ? "unknown" : `${Math.round(c.ageMinutes * 10) / 10} min`,
      required: `<= ${ENTRY_RULES.maxAgeMinutes} min`,
    },
    { rule: "security", passed: c.security === ENTRY_RULES.requiredSecurity, actual: c.security, required: ENTRY_RULES.requiredSecurity },
    { rule: "alphaScore", passed: c.alphaScore >= ENTRY_RULES.minAlphaScore, actual: String(c.alphaScore), required: `>= ${ENTRY_RULES.minAlphaScore}` },
    {
      rule: "noBundle",
      passed: c.forensicsVerdict === "CLEAN_DISTRIBUTION",
      actual: c.forensicsVerdict === "INSUFFICIENT_DATA" ? "INSUFFICIENT_DATA (fail-closed)" : c.forensicsVerdict,
      required: "CLEAN_DISTRIBUTION",
    },
    { rule: "noCopycat", passed: c.copycatRisk === "NONE" || c.copycatRisk === "LOW", actual: c.copycatRisk, required: "NONE or LOW" },
  ];
  const failed = checks.filter((k) => !k.passed).map((k) => `${k.rule}: ${k.actual} (need ${k.required})`);
  return { passed: failed.length === 0, checks, failed };
}

export interface Mark {
  priceUsd: number;
  liquidityUsd?: number;
}

export interface GuardResult {
  pnlPct: number;
  highWaterPct: number;
  lowWaterPct: number;
  breakEvenArmed: boolean;
  /** Currently effective stop level (percent vs entry). */
  stopPct: number;
  exit?: ExitReason;
  detail?: string;
  liquidityDropPct?: number;
}

/** Evaluates the guard for one position at one observation. Pure; does not mutate. */
export function evaluateGuard(pos: Pick<Position, "entryPriceUsd" | "entryLiquidityUsd" | "highWaterPct" | "lowWaterPct" | "breakEvenArmed">, mark: Mark): GuardResult {
  const pnlPct = (mark.priceUsd / pos.entryPriceUsd - 1) * 100;
  const highWaterPct = Math.max(pos.highWaterPct, pnlPct);
  const lowWaterPct = Math.min(pos.lowWaterPct, pnlPct);
  const breakEvenArmed = pos.breakEvenArmed || highWaterPct >= GUARD.breakEvenTriggerPct;
  const stopPct = breakEvenArmed ? GUARD.breakEvenStopPct : GUARD.stopLossPct;
  const liqDrop = mark.liquidityUsd !== undefined && pos.entryLiquidityUsd > 0 ? (1 - mark.liquidityUsd / pos.entryLiquidityUsd) * 100 : undefined;

  const base = { pnlPct, highWaterPct, lowWaterPct, breakEvenArmed, stopPct, liquidityDropPct: liqDrop };
  if (liqDrop !== undefined && liqDrop > GUARD.emergencyLiquidityDropPct) {
    return { ...base, exit: "EMERGENCY_LIQUIDITY", detail: `Liquidity fell ${liqDrop.toFixed(1)}% from entry (limit ${GUARD.emergencyLiquidityDropPct}%)` };
  }
  if (pnlPct >= GUARD.takeProfitPct) return { ...base, exit: "TAKE_PROFIT", detail: `+${pnlPct.toFixed(1)}% reached the +${GUARD.takeProfitPct}% target` };
  if (pnlPct <= stopPct) {
    return breakEvenArmed
      ? { ...base, exit: "BREAK_EVEN_STOP", detail: `Gain had reached +${highWaterPct.toFixed(1)}%; price fell back to ${pnlPct.toFixed(1)}% (break-even stop)` }
      : { ...base, exit: "STOP_LOSS", detail: `${pnlPct.toFixed(1)}% hit the ${GUARD.stopLossPct}% stop loss` };
  }
  return base;
}
