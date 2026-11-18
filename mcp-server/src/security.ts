import { GOPLUS_CHAIN_IDS, looksLikeEvmAddress, normalizeAddress, tokenKey } from "./chains.js";
import { fetchJson, HttpError, type HttpOptions } from "./http.js";
import { chunk, mapLimit, TokenBucket, TtlCache, type Clock, type Sleeper } from "./limiter.js";
import type { SecurityReport, SecurityStatus } from "./types.js";

export const RUGCHECK_BASE = "https://api.rugcheck.xyz";
export const GOPLUS_BASE = "https://api.gopluslabs.io";

/** RugCheck normalised score thresholds (0 = safest, 100 = riskiest). */
export const RUGCHECK_SAFE_BELOW = 21;
export const RUGCHECK_WARNING_MAX = 40;

/** EVM tax thresholds (fractions). */
export const TAX_WARNING = 0.1;
export const TAX_DANGER = 0.3;

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// ---------------------------------------------------------------------------
// RugCheck (Solana)
// ---------------------------------------------------------------------------

export interface RugRisk {
  name?: string;
  value?: string;
  description?: string;
  score?: number;
  level?: string;
}

export interface RugCheckSummary {
  score?: number;
  score_normalised?: number;
  lpLockedPct?: number;
  risks?: RugRisk[];
}

export interface RugCheckReport extends RugCheckSummary {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  token?: { mintAuthority?: string | null; freezeAuthority?: string | null };
  topHolders?: { pct?: number; address?: string; owner?: string; insider?: boolean }[] | null;
  rugged?: boolean;
  markets?: { pubkey?: string; lp?: { lpLockedPct?: number } }[];
  /** address -> label. AMM / LOCKER / CEX accounts are not "whales". */
  knownAccounts?: Record<string, { name?: string; type?: string }> | null;
}

/**
 * Top-holder concentration that ignores liquidity pools, lockers and exchanges
 * (otherwise a pool vault holding 25% of supply looks like a whale). Creator wallets are kept.
 */
export function holderConcentration(report: RugCheckReport | null | undefined): { top?: number; top10?: number; excluded: number } {
  const holders = report?.topHolders ?? [];
  const skip = new Set<string>();
  for (const [addr, info] of Object.entries(report?.knownAccounts ?? {})) if (info?.type !== "CREATOR") skip.add(addr);
  for (const m of report?.markets ?? []) if (m.pubkey) skip.add(m.pubkey);
  let excluded = 0;
  const pcts: number[] = [];
  for (const h of holders) {
    if (typeof h.pct !== "number") continue;
    if ((h.address && skip.has(h.address)) || (h.owner && skip.has(h.owner))) {
      excluded++;
      continue;
    }
    pcts.push(h.pct);
  }
  if (!pcts.length) return { excluded };
  pcts.sort((a, b) => b - a);
  return { top: round(pcts[0] ?? 0), top10: round(pcts.slice(0, 10).reduce((a, b) => a + b, 0)), excluded };
}

function isActiveAuthority(v: string | null | undefined): boolean | undefined {
  if (v === undefined) return undefined; // unknown
  return !!v && v !== SYSTEM_PROGRAM;
}

function riskLabel(r: RugRisk): string {
  const base = r.name ?? "Unnamed risk";
  const extra = r.value ? ` (${r.value})` : "";
  return `${base}${extra}${r.level ? ` [${r.level}]` : ""}`;
}

/**
 * Pure classifier: RugCheck summary and/or full report -> SecurityReport.
 * SAFE: normalised < 21 | WARNING: 21-40 | DANGER: > 40, or mint/freeze authority active.
 */
export function classifyRugCheck(
  address: string,
  summary?: RugCheckSummary | null,
  report?: RugCheckReport | null,
): SecurityReport {
  const base: SecurityReport = { status: "UNVERIFIED", chainId: "solana", address, source: "rugcheck", verdict: "", flags: [] };
  const data: RugCheckReport = { ...(summary ?? {}), ...(report ?? {}) };
  const risks = data.risks ?? report?.risks ?? summary?.risks ?? [];

  let score = data.score_normalised;
  if (score === undefined && typeof data.score === "number") {
    score = Math.min(100, Math.max(0, data.score));
    base.flags.push("RugCheck returned only a raw score; treated as a 0-100 value");
  }
  if (typeof score !== "number" || Number.isNaN(score)) {
    base.verdict = "UNVERIFIED: RugCheck returned no risk score. Treat as unsafe until verified.";
    return base;
  }
  base.riskScore = score;

  // Authorities: prefer explicit report fields; otherwise infer from the risk list.
  const mintRaw = report?.mintAuthority !== undefined ? report.mintAuthority : report?.token?.mintAuthority;
  const freezeRaw = report?.freezeAuthority !== undefined ? report.freezeAuthority : report?.token?.freezeAuthority;
  let mintActive = isActiveAuthority(mintRaw);
  let freezeActive = isActiveAuthority(freezeRaw);
  const names = risks.map((r) => r.name ?? "");
  if (mintActive === undefined && (summary || report)) {
    mintActive = names.some((n) => /mint authority/i.test(n));
  }
  if (freezeActive === undefined && (summary || report)) {
    freezeActive = names.some((n) => /freeze authority/i.test(n));
  }
  if (mintRaw !== undefined) base.mintAuthority = mintRaw;
  if (freezeRaw !== undefined) base.freezeAuthority = freezeRaw;
  base.mintAuthorityActive = mintActive;
  base.freezeAuthorityActive = freezeActive;

  // Holder concentration (RugCheck reports pct as a percentage, e.g. 12.5 = 12.5%).
  const conc = holderConcentration(report);
  if (conc.top !== undefined) {
    base.topHolderPct = conc.top;
    base.top10HolderPct = conc.top10;
    if (conc.top >= 30) base.flags.push(`Top holder owns ${conc.top}% of supply`);
  }
  const lp = data.lpLockedPct ?? report?.markets?.find((m) => typeof m.lp?.lpLockedPct === "number")?.lp?.lpLockedPct;
  if (typeof lp === "number") base.lpLockedPct = round(lp);

  for (const r of risks) base.flags.push(riskLabel(r));
  if (mintActive) base.flags.unshift("Mint authority is ACTIVE: supply can be inflated");
  if (freezeActive) base.flags.unshift("Freeze authority is ACTIVE: wallets can be frozen");
  if (report?.rugged) base.flags.unshift("RugCheck marks this token as RUGGED");

  let status: SecurityStatus;
  if (report?.rugged || score > RUGCHECK_WARNING_MAX || mintActive || freezeActive) status = "DANGER";
  else if (score >= RUGCHECK_SAFE_BELOW) status = "WARNING";
  else status = "SAFE";
  base.status = status;

  const bits = [`RugCheck risk ${score}/100`];
  if (mintActive) bits.push("mint authority ACTIVE");
  if (freezeActive) bits.push("freeze authority ACTIVE");
  if (typeof base.top10HolderPct === "number") bits.push(`top-10 holders ${base.top10HolderPct}%`);
  base.verdict = `${status}: ${bits.join("; ")}.`;
  return base;
}

// ---------------------------------------------------------------------------
// GoPlus (EVM)
// ---------------------------------------------------------------------------

/** GoPlus encodes booleans as "0"/"1" strings and numbers as decimal strings. */
export interface GoPlusTokenSecurity {
  is_honeypot?: string;
  buy_tax?: string;
  sell_tax?: string;
  cannot_sell_all?: string;
  cannot_buy?: string;
  owner_change_balance?: string;
  is_open_source?: string;
  hidden_owner?: string;
  can_take_back_ownership?: string;
  transfer_pausable?: string;
  /** percent is a fraction (0.25 = 25%). */
  holders?: { address?: string; percent?: string; is_contract?: number | string; is_locked?: number | string }[] | null;
  [k: string]: unknown;
}

const flag = (v: unknown): boolean | undefined => (v === "1" || v === 1 || v === true ? true : v === "0" || v === 0 || v === false ? false : undefined);
const frac = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Pure classifier: GoPlus token_security entry -> SecurityReport. */
export function classifyGoPlus(chainId: string, address: string, entry?: GoPlusTokenSecurity | null): SecurityReport {
  const base: SecurityReport = { status: "UNVERIFIED", chainId, address, source: "goplus", verdict: "", flags: [] };
  if (!entry || typeof entry !== "object" || Object.keys(entry).length === 0) {
    base.verdict = "UNVERIFIED: GoPlus has no data for this contract. Treat as unsafe until verified.";
    return base;
  }
  const honeypot = flag(entry.is_honeypot);
  if (honeypot === undefined) {
    base.verdict = "UNVERIFIED: GoPlus returned no honeypot verdict for this contract (often a very new token).";
    return base;
  }
  const cannotSellAll = flag(entry.cannot_sell_all);
  const ownerChange = flag(entry.owner_change_balance);
  const openSource = flag(entry.is_open_source);
  const buyTax = frac(entry.buy_tax);
  const sellTax = frac(entry.sell_tax);
  Object.assign(base, {
    isHoneypot: honeypot,
    cannotSellAll,
    ownerChangeBalance: ownerChange,
    isOpenSource: openSource,
    buyTax,
    sellTax,
  });

  // Wallet concentration: contracts (pools, lockers, routers) are excluded.
  const wallets = (entry.holders ?? [])
    .filter((h) => !flag(h.is_contract))
    .map((h) => (frac(h.percent) ?? 0) * 100)
    .sort((a, b) => b - a);
  if (wallets.length) {
    base.topHolderPct = round(wallets[0] ?? 0);
    base.top10HolderPct = round(wallets.slice(0, 10).reduce((a, b) => a + b, 0));
  }

  const danger: string[] = [];
  const warn: string[] = [];
  if (honeypot) danger.push("Honeypot: tokens cannot be sold");
  if (cannotSellAll) danger.push("Cannot sell all tokens");
  if (ownerChange) danger.push("Owner can change holder balances");
  if (flag(entry.cannot_buy)) danger.push("Buying is disabled");
  if ((buyTax ?? 0) > TAX_DANGER) danger.push(`Buy tax ${pct(buyTax)}`);
  if ((sellTax ?? 0) > TAX_DANGER) danger.push(`Sell tax ${pct(sellTax)}`);

  if ((buyTax ?? 0) > TAX_WARNING && (buyTax ?? 0) <= TAX_DANGER) warn.push(`Elevated buy tax ${pct(buyTax)}`);
  if ((sellTax ?? 0) > TAX_WARNING && (sellTax ?? 0) <= TAX_DANGER) warn.push(`Elevated sell tax ${pct(sellTax)}`);
  if (buyTax === undefined || sellTax === undefined) warn.push("Tax rates unavailable (trade simulation not possible)");
  if (openSource === false) warn.push("Contract source is not verified/open source");
  if (openSource === undefined) warn.push("Open-source status unknown");
  if (flag(entry.hidden_owner)) warn.push("Hidden owner");
  if (flag(entry.can_take_back_ownership)) warn.push("Ownership can be taken back");
  if (flag(entry.transfer_pausable)) warn.push("Transfers can be paused");

  base.flags = [...danger, ...warn];
  base.status = danger.length ? "DANGER" : warn.length ? "WARNING" : "SAFE";
  const tax = `buy tax ${pct(buyTax)}, sell tax ${pct(sellTax)}`;
  base.verdict = base.flags.length ? `${base.status}: ${base.flags.join("; ")} (${tax}).` : `SAFE: no honeypot or ownership red flags (${tax}).`;
  return base;
}

function pct(n: number | undefined): string {
  return n === undefined ? "n/a" : `${round(n * 100)}%`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Auditor (network)
// ---------------------------------------------------------------------------

export interface AuditorOptions extends HttpOptions {
  rugcheckBase?: string;
  goplusBase?: string;
  cacheTtlMs?: number;
  now?: Clock;
}

export interface AuditOptions {
  /** Also fetch the full RugCheck report (authority addresses, holders). Default false. */
  deep?: boolean;
}

export class SecurityAuditor {
  private readonly cache: TtlCache<SecurityReport>;
  /** Raw RugCheck responses, so a deep audit reuses the summary a lite audit just fetched. */
  private readonly rugRaw: TtlCache<unknown>;
  private readonly rugBucket: TokenBucket;
  private readonly goplusBucket: TokenBucket;
  private readonly http: HttpOptions;
  private readonly rugBase: string;
  private readonly goBase: string;

  constructor(opts: AuditorOptions = {}) {
    this.rugBase = opts.rugcheckBase ?? RUGCHECK_BASE;
    this.goBase = opts.goplusBase ?? GOPLUS_BASE;
    this.cache = new TtlCache<SecurityReport>(opts.cacheTtlMs ?? 120_000, opts.now);
    this.rugRaw = new TtlCache<unknown>(opts.cacheTtlMs ?? 120_000, opts.now);
    this.http = {
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      timeoutMs: opts.timeoutMs ?? 8_000,
      retries: opts.retries ?? 1,
      baseDelayMs: opts.baseDelayMs ?? 400,
    };
    const bucket = (capacity: number, perMin: number) => new TokenBucket({ capacity, refillPerMinute: perMin, now: opts.now, sleep: opts.sleep as Sleeper | undefined });
    this.rugBucket = bucket(10, 50);
    this.goplusBucket = bucket(8, 25);
  }

  /** Never throws: any failure becomes an UNVERIFIED report (fail closed). */
  async audit(chainId: string, address: string, options: AuditOptions = {}): Promise<SecurityReport> {
    const chain = chainId.toLowerCase();
    const addr = address.trim();
    // Only RugCheck has a heavier "deep" report; GoPlus already returns everything in one call.
    const deep = !!options.deep && chain === "solana";
    const key = `${deep ? "deep" : "lite"}|${tokenKey(chain, addr)}`;
    const deepKey = `deep|${tokenKey(chain, addr)}`;
    const cached = this.cache.get(deepKey) ?? this.cache.get(key);
    if (cached) return cached;
    try {
      const report = await this.cache.wrap(key, async () => {
        const r = chain === "solana" ? await this.auditSolana(addr, deep) : await this.auditEvm(chain, addr);
        if (r.status === "UNVERIFIED") throw new UnverifiedResult(r);
        return r;
      });
      return report;
    } catch (e) {
      if (e instanceof UnverifiedResult) return e.report;
      return unverified(chain, addr, `Security check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Audits many tokens of one chain. EVM contracts go to GoPlus in batches of up to 20 addresses per request (one
   * rate-limit token per batch instead of one per address); Solana mints use RugCheck with limited concurrency;
   * chains without a provider resolve instantly as UNVERIFIED. Respects and fills the same cache as `audit()`.
   */
  async auditBatch(chainId: string, addresses: readonly string[]): Promise<Map<string, SecurityReport>> {
    const chain = chainId.toLowerCase();
    const out = new Map<string, SecurityReport>();
    const key = (a: string) => `lite|${tokenKey(chain, a.trim())}`;
    const deepKey = (a: string) => `deep|${tokenKey(chain, a.trim())}`;
    const todo: string[] = [];
    for (const raw of new Set(addresses.map((a) => a.trim()))) {
      const cached = this.cache.get(deepKey(raw)) ?? this.cache.get(key(raw));
      if (cached) out.set(raw, cached);
      else todo.push(raw);
    }
    const numeric = GOPLUS_CHAIN_IDS[chain];
    if (chain === "solana" || numeric === undefined) {
      const reports = await mapLimit(todo, 5, (a) => this.audit(chain, a));
      todo.forEach((a, i) => out.set(a, reports[i]!));
      return out;
    }
    const valid = todo.filter((a) => looksLikeEvmAddress(a));
    for (const a of todo) if (!valid.includes(a)) out.set(a, unverified(chain, a, "Not a valid EVM contract address"));
    await Promise.all(
      chunk(valid, 20).map(async (group) => {
        await this.goplusBucket.acquire();
        try {
          const res = await fetchJson<{ code?: number; message?: string; result?: Record<string, GoPlusTokenSecurity> | unknown[] }>(
            `${this.goBase}/api/v1/token_security/${numeric}?contract_addresses=${group.map((a) => a.toLowerCase()).join(",")}`,
            this.http,
          );
          if (res.code !== undefined && res.code !== 1) throw new Error(`GoPlus error ${res.code}: ${res.message ?? "unknown"}`);
          const result = res.result && !Array.isArray(res.result) ? res.result : {};
          for (const a of group) {
            const r = classifyGoPlus(chain, a, result[a.toLowerCase()] ?? result[normalizeAddress(chain, a)]);
            out.set(a, r);
            if (r.status !== "UNVERIFIED") this.cache.set(key(a), r); // like audit(): UNVERIFIED is never cached
          }
        } catch (e) {
          for (const a of group) out.set(a, unverified(chain, a, `GoPlus unavailable: ${errMsg(e)}`, "goplus"));
        }
      }),
    );
    return out;
  }

  private async auditSolana(mint: string, deep: boolean): Promise<SecurityReport> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return unverified("solana", mint, "Not a valid Solana mint address");
    const path = encodeURIComponent(mint);
    const summaryP = this.rugGet<RugCheckSummary>(`/v1/tokens/${path}/report/summary`);
    const reportP = deep ? this.rugGet<RugCheckReport>(`/v1/tokens/${path}/report`) : undefined;
    const [summary, report] = await Promise.allSettled([summaryP, reportP ?? Promise.resolve(undefined)]);
    const s = summary.status === "fulfilled" ? summary.value : undefined;
    let r = report.status === "fulfilled" ? report.value : undefined;

    // Fallback: summary unusable -> try the full report.
    if ((!s || (s.score_normalised === undefined && s.score === undefined)) && !r) {
      try {
        r = await this.rugGet<RugCheckReport>(`/v1/tokens/${path}/report`);
      } catch (e) {
        return unverified("solana", mint, `RugCheck unavailable: ${errMsg(e)}`, "rugcheck");
      }
    }
    return classifyRugCheck(mint, s, r);
  }

  private async auditEvm(chain: string, address: string): Promise<SecurityReport> {
    const numeric = GOPLUS_CHAIN_IDS[chain];
    if (numeric === undefined) {
      return unverified(chain, address, `No security provider for chain "${chain}" (supported: solana, ${Object.keys(GOPLUS_CHAIN_IDS).join(", ")})`);
    }
    if (!looksLikeEvmAddress(address)) return unverified(chain, address, "Not a valid EVM contract address");
    await this.goplusBucket.acquire();
    try {
      const res = await fetchJson<{ code?: number; message?: string; result?: Record<string, GoPlusTokenSecurity> | unknown[] }>(
        `${this.goBase}/api/v1/token_security/${numeric}?contract_addresses=${address.toLowerCase()}`,
        this.http,
      );
      if (res.code !== undefined && res.code !== 1) return unverified(chain, address, `GoPlus error ${res.code}: ${res.message ?? "unknown"}`, "goplus");
      const result = res.result && !Array.isArray(res.result) ? res.result : {};
      const entry = result[address.toLowerCase()] ?? result[normalizeAddress(chain, address)];
      return classifyGoPlus(chain, address, entry);
    } catch (e) {
      return unverified(chain, address, `GoPlus unavailable: ${errMsg(e)}`, "goplus");
    }
  }

  private async rugGet<T>(path: string): Promise<T> {
    return this.rugRaw.wrap(path, async () => {
      await this.rugBucket.acquire();
      return fetchJson<unknown>(`${this.rugBase}${path}`, this.http);
    }) as Promise<T>;
  }
}

class UnverifiedResult extends Error {
  constructor(readonly report: SecurityReport) {
    super(report.verdict);
  }
}

function errMsg(e: unknown): string {
  if (e instanceof HttpError) return e.status ? `HTTP ${e.status}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

export function unverified(chainId: string, address: string, reason: string, source: SecurityReport["source"] = "none"): SecurityReport {
  return {
    status: "UNVERIFIED",
    chainId,
    address,
    source,
    verdict: `UNVERIFIED: ${reason}. Treat as unsafe until verified.`,
    flags: [reason],
  };
}
