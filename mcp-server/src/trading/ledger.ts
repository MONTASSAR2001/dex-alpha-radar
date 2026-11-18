/**
 * Local JSON trade ledger: ~/.dex-alpha-radar/trades.json (override the directory with
 * DEX_ALPHA_RADAR_HOME). Writes are atomic (temp file + rename) with owner-only permissions,
 * and every mutation is synchronous (load -> change -> save) so the in-process monitor and
 * tool calls cannot interleave. A corrupt file is moved aside, never overwritten.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type TradeMode = "paper" | "live";
export type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "BREAK_EVEN_STOP" | "EMERGENCY_LIQUIDITY" | "MANUAL";

export interface PositionExit {
  at: string;
  /** Effective fill price (after slippage / impact). */
  priceUsd: number;
  refPriceUsd: number;
  reason: ExitReason;
  feesUsd: number;
  pnlUsd: number;
  pnlPct: number;
  signature?: string;
  fillSource: "jupiter" | "model";
}

export interface EntrySnapshot {
  ageMinutes: number | null;
  alphaScore: number;
  security: string;
  forensics: string;
  holderSafetyScore: number | null;
  copycatRisk: string;
  narrativeVerdict?: string;
  /** False when the paper trade deliberately bypassed the entry rules (excluded from "strict" stats). */
  rulesEnforced: boolean;
  rulesPassed: boolean;
}

export interface Position {
  id: string;
  mode: TradeMode;
  status: "open" | "closed";
  chain: string;
  tokenAddress: string;
  symbol: string;
  name?: string;
  pairAddress: string;
  url?: string;
  openedAt: string;
  /** USD notional swapped into the token (fees are separate). */
  sizeUsd: number;
  entryFeesUsd: number;
  tokenQty: number;
  rawQty?: string;
  decimals?: number;
  entryRefPriceUsd: number;
  /** Effective fill price including slippage and price impact. */
  entryPriceUsd: number;
  slippageBps: number;
  priorityFeeLamports: number;
  fillSource: "jupiter" | "model";
  entryLiquidityUsd: number;
  entry: EntrySnapshot;
  // guard state
  highWaterPct: number;
  lowWaterPct: number;
  breakEvenArmed: boolean;
  lastCheckedAt?: string;
  lastPriceUsd?: number;
  lastLiquidityUsd?: number;
  // live
  signature?: string;
  confirmed?: boolean;
  exit?: PositionExit;
}

export interface LedgerData {
  version: 1;
  positions: Position[];
}

export function ledgerDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEX_ALPHA_RADAR_HOME ? env.DEX_ALPHA_RADAR_HOME : join(homedir(), ".dex-alpha-radar");
}

export class TradeLedger {
  readonly path: string;

  constructor(path?: string) {
    this.path = path ?? join(ledgerDir(), "trades.json");
  }

  load(): LedgerData {
    if (!existsSync(this.path)) return { version: 1, positions: [] };
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as LedgerData;
      if (!data || !Array.isArray(data.positions)) throw new Error("bad shape");
      return { version: 1, positions: data.positions };
    } catch {
      // Keep the unreadable file for recovery and start a fresh ledger.
      renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
      return { version: 1, positions: [] };
    }
  }

  private save(data: LedgerData): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* not fatal on filesystems without chmod */
    }
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Synchronous read-modify-write. Return value of `fn` is passed through. */
  mutate<T>(fn: (data: LedgerData) => T): T {
    const data = this.load();
    const out = fn(data);
    this.save(data);
    return out;
  }

  list(filter: { status?: "open" | "closed"; mode?: TradeMode | "all"; since?: number } = {}): Position[] {
    return this.load().positions.filter(
      (p) =>
        (!filter.status || p.status === filter.status) &&
        (!filter.mode || filter.mode === "all" || p.mode === filter.mode) &&
        (!filter.since || Date.parse(p.openedAt) >= filter.since),
    );
  }

  get(id: string): Position | undefined {
    return this.load().positions.find((p) => p.id === id);
  }

  add(p: Omit<Position, "id">): Position {
    const position: Position = { id: randomUUID().slice(0, 8), ...p };
    this.mutate((d) => void d.positions.push(position));
    return position;
  }

  update(id: string, fn: (p: Position) => void): Position | undefined {
    return this.mutate((d) => {
      const p = d.positions.find((x) => x.id === id);
      if (p) fn(p);
      return p;
    });
  }

  /** Realised losses (positive USD) on live trades closed on the given UTC day. */
  dailyRealizedLossUsd(mode: TradeMode, now = Date.now()): number {
    const day = new Date(now).toISOString().slice(0, 10);
    return this.list({ status: "closed", mode }).reduce((loss, p) => (p.exit && p.exit.at.slice(0, 10) === day && p.exit.pnlUsd < 0 ? loss - p.exit.pnlUsd : loss), 0);
  }
}
