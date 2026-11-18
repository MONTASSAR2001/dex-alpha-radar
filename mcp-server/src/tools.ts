import { looksLikeAddress, looksLikeEvmAddress, looksLikeSolanaAddress, normalizeAddress, normalizeChain, tokenKey } from "./chains.js";
import { bestPairPerToken, dexUrl, type DexScreenerClient } from "./dexscreener.js";
import { mapLimit } from "./limiter.js";
import { fetchBrowserTrending, type BrowserTrendingOptions, type BrowserTrendingResult } from "./browserFallback.js";
import { analyzeWashTrading, buyRatio, computeAlphaScore, detectBreakout, pairAgeHours, type BreakoutSignal } from "./scoring.js";
import { unverified, type SecurityAuditor } from "./security.js";
import { GECKO_NETWORKS, geckoPoolToPair, type GeckoPool, type GeckoTerminalClient } from "./geckoterminal.js";
import type { AlphaScore, Catalysts, DexPair, DexTokenSignal, SecurityReport } from "./types.js";

export interface ToolDeps {
  dex: DexScreenerClient;
  security: SecurityAuditor;
  /** GeckoTerminal client for `detect_fresh_births` (new pools). Optional: without it only DexScreener sources are used. */
  gecko?: GeckoTerminalClient;
  now?: () => number;
  /** Browser trending source (optional; defaults to the Playwright implementation). */
  trending?: (opts: BrowserTrendingOptions) => Promise<BrowserTrendingResult>;
}

export const DISCLAIMER =
  "Research output only, not financial advice. Meme coins are extremely high risk; security checks reduce but never remove rug-pull risk. Verify the contract address yourself and never risk funds you cannot lose.";

/** Cap on security audits per tool call, to respect upstream rate limits. */
const MAX_AUDITS = 15;
const AUDIT_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

export interface Candidate {
  chainId: string;
  tokenAddress: string;
  sources: string[];
  boostAmount: number;
  cto: boolean;
}

export interface Discovery {
  candidates: Candidate[];
  warnings: string[];
}

/** Merges boosts, top boosts, profiles and CTOs into a de-duplicated candidate list. */
export async function collectCandidates(dex: DexScreenerClient, chain: string, maxCandidates = 120): Promise<Discovery> {
  const wanted = normalizeChain(chain);
  const sources: [string, Promise<DexTokenSignal[]>][] = [
    ["boost_latest", dex.boostsLatest()],
    ["boost_top", dex.boostsTop()],
    ["profile_latest", dex.profilesLatest()],
    ["cto_latest", dex.ctoLatest()],
  ];
  const settled = await Promise.allSettled(sources.map(([, p]) => p));
  const warnings: string[] = [];
  const merged = new Map<string, Candidate>();

  settled.forEach((res, i) => {
    const name = sources[i]![0];
    if (res.status === "rejected") {
      warnings.push(`${name} unavailable: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`);
      return;
    }
    for (const s of res.value) {
      if (!s.chainId || !s.tokenAddress) continue;
      if (wanted !== "all" && s.chainId.toLowerCase() !== wanted) continue;
      const key = tokenKey(s.chainId, s.tokenAddress);
      const c = merged.get(key) ?? { chainId: s.chainId.toLowerCase(), tokenAddress: s.tokenAddress, sources: [], boostAmount: 0, cto: false };
      if (!c.sources.includes(name)) c.sources.push(name);
      if (name.startsWith("boost")) c.boostAmount = Math.max(c.boostAmount, s.totalAmount ?? s.amount ?? 0);
      if (name === "cto_latest") c.cto = true;
      merged.set(key, c);
    }
  });

  if (settled.every((r) => r.status === "rejected")) {
    throw new Error(`All DexScreener discovery endpoints failed. ${warnings.join(" | ")}`);
  }
  const candidates = [...merged.values()]
    .sort((a, b) => b.sources.length - a.sources.length || b.boostAmount - a.boostAmount)
    .slice(0, maxCandidates);
  return { candidates, warnings };
}

export interface TrendingInfo {
  requested: true;
  status: BrowserTrendingResult["status"];
  pairsFound: number;
  tokensAdded: number;
  message: string;
}

/**
 * Optional browser source: trending pair addresses -> base tokens, so they enter the exact
 * same batch fetch + audit + score pipeline as the API-discovered candidates.
 */
export async function trendingCandidates(deps: ToolDeps, chain: string): Promise<{ candidates: Candidate[]; info: TrendingInfo }> {
  const run = deps.trending ?? fetchBrowserTrending;
  const res = await run({ chain: chain === "all" ? undefined : chain, limit: 30 }).catch(
    (e): BrowserTrendingResult => ({ status: "error", pairs: [], message: `Browser trending failed: ${e instanceof Error ? e.message : String(e)}` }),
  );
  const info: TrendingInfo = { requested: true, status: res.status, pairsFound: res.pairs.length, tokensAdded: 0, message: res.message };
  const refs = res.pairs.filter((r) => chain === "all" || r.chainId.toLowerCase() === chain);
  if (!refs.length) return { candidates: [], info };

  const byChain = new Map<string, string[]>();
  for (const r of refs) byChain.set(r.chainId.toLowerCase(), [...(byChain.get(r.chainId.toLowerCase()) ?? []), r.pairAddress]);
  const fetched = await Promise.allSettled([...byChain].map(([c, ids]) => deps.dex.getPairs(c, ids)));
  const seen = new Map<string, Candidate>();
  for (const f of fetched) {
    if (f.status !== "fulfilled") continue;
    for (const p of f.value) {
      const key = tokenKey(p.chainId, p.baseToken.address);
      if (!seen.has(key)) seen.set(key, { chainId: p.chainId.toLowerCase(), tokenAddress: p.baseToken.address, sources: ["browser_trending"], boostAmount: 0, cto: false });
    }
  }
  info.tokensAdded = seen.size;
  return { candidates: [...seen.values()], info };
}

/** Merges extra candidates into a discovery list (sources are unioned). */
export function mergeCandidates(base: Candidate[], extra: Candidate[], max = 150): Candidate[] {
  const merged = new Map(base.map((c) => [tokenKey(c.chainId, c.tokenAddress), { ...c, sources: [...c.sources] }]));
  for (const x of extra) {
    const key = tokenKey(x.chainId, x.tokenAddress);
    const cur = merged.get(key);
    if (cur) cur.sources.push(...x.sources.filter((s) => !cur.sources.includes(s)));
    else merged.set(key, { ...x });
  }
  return [...merged.values()].sort((a, b) => b.sources.length - a.sources.length || b.boostAmount - a.boostAmount).slice(0, max);
}

interface Enriched {
  pair: DexPair;
  catalysts: Catalysts;
}

/** Batch-fetches live pairs for candidates (grouped by chain, <=30 per call) and keeps the best pool per token. */
export async function fetchCandidatePairs(dex: DexScreenerClient, candidates: Candidate[]): Promise<Enriched[]> {
  const byChain = new Map<string, Candidate[]>();
  for (const c of candidates) byChain.set(c.chainId, [...(byChain.get(c.chainId) ?? []), c]);
  const lookup = new Map(candidates.map((c) => [tokenKey(c.chainId, c.tokenAddress), c]));

  const fetched = await Promise.allSettled(
    [...byChain].map(([chainId, list]) =>
      dex.getTokenPairs(
        chainId,
        list.map((c) => c.tokenAddress),
      ),
    ),
  );
  const pairs = fetched.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const out: Enriched[] = [];
  for (const [key, pair] of bestPairPerToken(pairs)) {
    const cand = lookup.get(key);
    out.push({
      pair,
      catalysts: {
        boosted: (cand?.boostAmount ?? 0) > 0 || (pair.boosts?.active ?? 0) > 0,
        boostAmount: cand?.boostAmount || undefined,
        cto: cand?.cto ?? false,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

function pickLinks(pair: DexPair) {
  const websites = (pair.info?.websites ?? []).map((w) => w.url).filter(Boolean);
  const socials: Record<string, string> = {};
  for (const s of pair.info?.socials ?? []) if (s.url && s.type && !socials[s.type]) socials[s.type] = s.url;
  return { websites, socials };
}

function securitySummary(s: SecurityReport | undefined) {
  if (!s) return { status: "UNVERIFIED", verdict: "Not audited" };
  return { status: s.status, verdict: s.verdict, flags: s.flags.slice(0, 8), source: s.source };
}

export function describePair(pair: DexPair, catalysts: Catalysts, score: AlphaScore, security: SecurityReport | undefined, now: number) {
  const age = pairAgeHours(pair, now);
  return {
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    chain: pair.chainId,
    tokenAddress: pair.baseToken.address,
    pairAddress: pair.pairAddress,
    dex: pair.dexId,
    quote: pair.quoteToken?.symbol,
    url: dexUrl(pair),
    /** Exact string from the API; never reformat. */
    priceUsd: pair.priceUsd,
    fdv: pair.fdv,
    marketCap: pair.marketCap,
    liquidityUsd: pair.liquidity?.usd,
    ageHours: age === undefined ? undefined : Math.round(age * 10) / 10,
    priceChangePct: pair.priceChange,
    volumeUsd: pair.volume,
    txns: pair.txns,
    buyRatio: {
      m5: round3(buyRatio(pair.txns?.m5?.buys, pair.txns?.m5?.sells)),
      h1: round3(buyRatio(pair.txns?.h1?.buys, pair.txns?.h1?.sells)),
    },
    links: pickLinks(pair),
    catalysts,
    alphaScore: score.alphaScore,
    rejected: score.rejected,
    scoreBreakdown: score.breakdown,
    reasons: score.reasons,
    warnings: score.warnings,
    tradeQuality: tradeQuality(pair),
    security: securitySummary(security),
  };
}

function tradeQuality(pair: DexPair) {
  const w = analyzeWashTrading(pair);
  return { avgTradeUsd1h: w.avgTradeUsd, txns1h: w.txns1h, volumeToLiquidity1h: w.volumeToLiquidity, washSuspected: w.suspected };
}

function round3(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.round(n * 1000) / 1000;
}

async function auditAll(deps: ToolDeps, items: Enriched[], deep = false): Promise<Map<string, SecurityReport>> {
  const reports = await mapLimit(items, AUDIT_CONCURRENCY, (e) => deps.security.audit(e.pair.chainId, e.pair.baseToken.address, { deep }));
  return new Map(items.map((e, i) => [tokenKey(e.pair.chainId, e.pair.baseToken.address), reports[i]!]));
}

/** Different tokens sharing a ticker inside one result set are a classic copycat pattern. */
export function flagDuplicateSymbols<T extends { symbol: string; tokenAddress: string; chain: string; warnings: string[] }>(rows: T[]): T[] {
  const byTicker = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = r.symbol.toLowerCase();
    byTicker.set(k, (byTicker.get(k) ?? new Set()).add(`${r.chain}:${r.tokenAddress.toLowerCase()}`));
  }
  return rows.map((r) => {
    const n = byTicker.get(r.symbol.toLowerCase())?.size ?? 0;
    return n > 1 ? { ...r, warnings: [...r.warnings, `Ticker $${r.symbol} is shared by ${n} different tokens in these results (possible copycat): verify the contract address`] } : r;
  });
}

const secKey = (p: DexPair) => tokenKey(p.chainId, p.baseToken.address);

/**
 * Upgrades the audits of the final shortlist to deep audits (authority addresses, holder
 * concentration). A deep audit that fails never downgrades a lite audit that succeeded.
 */
async function deepen(deps: ToolDeps, items: { e: Enriched; sec?: SecurityReport }[]): Promise<(SecurityReport | undefined)[]> {
  const deep = await mapLimit(items, AUDIT_CONCURRENCY, (x) => deps.security.audit(x.e.pair.chainId, x.e.pair.baseToken.address, { deep: true }));
  return items.map((x, i) => (deep[i]!.status === "UNVERIFIED" && x.sec && x.sec.status !== "UNVERIFIED" ? x.sec : deep[i]));
}

// ---------------------------------------------------------------------------
// Tool 1: scan_opportunities
// ---------------------------------------------------------------------------

export interface ScanParams {
  chain?: string;
  minLiquidityUsd?: number;
  maxAgeHours?: number;
  includeRisky?: boolean;
  limit?: number;
  /** Also read DexScreener's trending view with a headless browser (optional, degrades gracefully). */
  useBrowserTrending?: boolean;
}

export async function scanOpportunities(deps: ToolDeps, p: ScanParams = {}) {
  const now = (deps.now ?? Date.now)();
  const chain = normalizeChain(p.chain ?? "all");
  const minLiq = p.minLiquidityUsd ?? 15_000;
  const maxAge = p.maxAgeHours ?? 72;
  const limit = p.limit ?? 10;
  const includeRisky = p.includeRisky ?? false;

  const trending = p.useBrowserTrending ? await trendingCandidates(deps, chain) : undefined;
  let discovery: Discovery;
  try {
    discovery = await collectCandidates(deps.dex, chain);
  } catch (e) {
    if (!trending?.candidates.length) throw e;
    discovery = { candidates: [], warnings: [e instanceof Error ? e.message : String(e)] };
  }
  const warnings = discovery.warnings;
  const candidates = trending ? mergeCandidates(discovery.candidates, trending.candidates) : discovery.candidates;
  if (trending && trending.info.status !== "ok") warnings.push(trending.info.message);
  const enriched = await fetchCandidatePairs(deps.dex, candidates);
  const filtered = enriched.filter(({ pair }) => {
    if ((pair.liquidity?.usd ?? 0) < minLiq) return false;
    const age = pairAgeHours(pair, now);
    return age !== undefined && age <= maxAge;
  });

  // Pre-rank without security, audit only the strongest, then re-rank.
  const prelim = filtered
    .map((e) => ({ e, s: computeAlphaScore(e.pair, e.catalysts, undefined, now).alphaScore }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.min(MAX_AUDITS, Math.max(limit * 2, limit)))
    .map((x) => x.e);
  const audits = await auditAll(deps, prelim);

  const rank = (rows: { e: Enriched; sec?: SecurityReport; score: AlphaScore }[]) =>
    rows
      .filter((x) => includeRisky || !x.score.rejected)
      .sort((a, b) => Number(a.score.rejected) - Number(b.score.rejected) || b.score.alphaScore - a.score.alphaScore);
  const shortlist = rank(
    prelim.map((e) => {
      const sec = audits.get(secKey(e.pair));
      return { e, sec, score: computeAlphaScore(e.pair, e.catalysts, sec, now) };
    }),
  ).slice(0, limit);
  // Deep-audit only the final shortlist (holder concentration, authority addresses), then re-rank.
  const deepSec = await deepen(deps, shortlist);
  const scored = rank(shortlist.map((x, i) => ({ e: x.e, sec: deepSec[i], score: computeAlphaScore(x.e.pair, x.e.catalysts, deepSec[i], now) })));

  return {
    generatedAt: new Date(now).toISOString(),
    filters: { chain, minLiquidityUsd: minLiq, maxAgeHours: maxAge, includeRisky, limit, useBrowserTrending: p.useBrowserTrending ?? false },
    ...(trending ? { trending: trending.info } : {}),
    stats: {
      candidates: candidates.length,
      pairsFetched: enriched.length,
      passedFilters: filtered.length,
      audited: prelim.length,
      returned: scored.length,
    },
    warnings,
    results: flagDuplicateSymbols(scored.map((x, i) => ({ rank: i + 1, ...describePair(x.e.pair, x.e.catalysts, x.score, x.sec, now) }))),
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Tool 2: inspect_token
// ---------------------------------------------------------------------------

export interface InspectParams {
  query: string;
  chain?: string;
}

export async function inspectToken(deps: ToolDeps, p: InspectParams) {
  const now = (deps.now ?? Date.now)();
  const query = p.query.trim();
  if (!query) throw new Error("query must not be empty");
  const chain = p.chain ? normalizeChain(p.chain) : undefined;

  let pairs = await deps.dex.search(query.replace(/^\$/, ""));
  if (chain && chain !== "all") pairs = pairs.filter((x) => x.chainId.toLowerCase() === chain);

  const isAddress = looksLikeAddress(query);
  let matches = pairs;
  if (isAddress) {
    const want = (c: string) => normalizeAddress(c, query);
    matches = pairs.filter((x) => normalizeAddress(x.chainId, x.baseToken.address) === want(x.chainId));
  } else {
    const q = query.replace(/^\$/, "").toLowerCase();
    const exact = pairs.filter((x) => x.baseToken.symbol.toLowerCase() === q || x.baseToken.name.toLowerCase() === q);
    matches = exact.length ? exact : pairs.filter((x) => x.baseToken.symbol.toLowerCase().includes(q) || x.baseToken.name.toLowerCase().includes(q));
  }
  if (!matches.length) {
    return { found: false as const, query, message: `No DexScreener pools found for "${query}"${chain ? ` on ${chain}` : ""}.`, disclaimer: DISCLAIMER };
  }

  // Group pools by token; the most liquid token is the primary match.
  const byToken = new Map<string, DexPair[]>();
  for (const m of matches) byToken.set(secKey(m), [...(byToken.get(secKey(m)) ?? []), m]);
  const liqOf = (list: DexPair[]) => list.reduce((s, x) => s + (x.liquidity?.usd ?? 0), 0);
  const tokens = [...byToken.values()].sort((a, b) => liqOf(b) - liqOf(a));
  const primaryPools = tokens[0]!.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const best = primaryPools[0]!;

  let cto = false;
  try {
    cto = (await deps.dex.ctoLatest()).some((s) => tokenKey(s.chainId, s.tokenAddress) === secKey(best));
  } catch {
    /* CTO lookup is best-effort */
  }
  const catalysts: Catalysts = { boosted: (best.boosts?.active ?? 0) > 0, boostAmount: best.boosts?.active, cto };
  const security = await deps.security.audit(best.chainId, best.baseToken.address, { deep: true });
  const score = computeAlphaScore(best, catalysts, security, now);

  return {
    found: true as const,
    query,
    token: describePair(best, catalysts, score, security, now),
    securityDetail: security,
    pools: primaryPools.slice(0, 5).map((x) => ({
      dex: x.dexId,
      quote: x.quoteToken?.symbol,
      pairAddress: x.pairAddress,
      liquidityUsd: x.liquidity?.usd,
      volumeH24: x.volume?.h24,
      priceUsd: x.priceUsd,
      url: dexUrl(x),
    })),
    otherMatches: tokens.slice(1, 6).map((list) => {
      const top = list.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]!;
      return {
        symbol: top.baseToken.symbol,
        name: top.baseToken.name,
        chain: top.chainId,
        tokenAddress: top.baseToken.address,
        liquidityUsd: liqOf(list),
        url: dexUrl(top),
      };
    }),
    warnings:
      tokens.length > 1 && !isAddress
        ? [`${tokens.length} different tokens match "${query}". Copycat tokens are common: confirm the contract address before acting.`]
        : [],
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Tool 3: audit_token_security
// ---------------------------------------------------------------------------

export interface AuditParams {
  chain: string;
  address: string;
}

export async function auditTokenSecurity(deps: ToolDeps, p: AuditParams) {
  const chain = normalizeChain(p.chain);
  const report = await deps.security.audit(chain, p.address.trim(), { deep: true });
  return { chain, ...report, disclaimer: DISCLAIMER };
}

// ---------------------------------------------------------------------------
// Tool 4: detect_momentum_breakouts
// ---------------------------------------------------------------------------

export interface BreakoutParams {
  chain?: string;
  minLiquidityUsd?: number;
  maxAgeHours?: number;
  minAcceleration?: number;
  minBuyRatio?: number;
  includeRisky?: boolean;
  limit?: number;
}

export async function detectMomentumBreakouts(deps: ToolDeps, p: BreakoutParams = {}) {
  const now = (deps.now ?? Date.now)();
  const chain = normalizeChain(p.chain ?? "all");
  const minLiq = p.minLiquidityUsd ?? 10_000;
  const maxAge = p.maxAgeHours ?? 168;
  const limit = p.limit ?? 10;
  const includeRisky = p.includeRisky ?? false;
  const thresholds = { minAcceleration: p.minAcceleration, minBuyRatio: p.minBuyRatio };

  const { candidates, warnings } = await collectCandidates(deps.dex, chain);
  const enriched = await fetchCandidatePairs(deps.dex, candidates);
  const pool = enriched.filter(({ pair }) => {
    if ((pair.liquidity?.usd ?? 0) < minLiq) return false;
    const age = pairAgeHours(pair, now);
    return age === undefined || age <= maxAge;
  });

  const signals = pool
    .map((e) => ({ e, sig: detectBreakout(e.pair, stripUndefined(thresholds)) }))
    .sort((a, b) => b.sig.breakoutScore - a.sig.breakoutScore);
  const hits = signals.filter((x) => x.sig.isBreakout).slice(0, Math.min(MAX_AUDITS, Math.max(limit * 2, limit)));
  const audits = await auditAll(
    deps,
    hits.map((h) => h.e),
  );

  const lite = hits
    .map((h) => {
      const sec = audits.get(secKey(h.e.pair));
      return { ...h, sec, score: computeAlphaScore(h.e.pair, h.e.catalysts, sec, now) };
    })
    .filter((x) => includeRisky || !x.score.rejected)
    .slice(0, limit);
  const deepSec = await deepen(deps, lite);
  const results = lite
    .map((h, i) => ({ ...h, sec: deepSec[i], score: computeAlphaScore(h.e.pair, h.e.catalysts, deepSec[i], now) }))
    .filter((x) => includeRisky || !x.score.rejected);

  return {
    generatedAt: new Date(now).toISOString(),
    filters: { chain, minLiquidityUsd: minLiq, maxAgeHours: maxAge, includeRisky, limit, thresholds: { minAcceleration: p.minAcceleration ?? 2, minBuyRatio: p.minBuyRatio ?? 0.6 } },
    stats: { candidates: candidates.length, scanned: pool.length, breakouts: signals.filter((x) => x.sig.isBreakout).length, returned: results.length },
    warnings,
    results: flagDuplicateSymbols(
      results.map((x, i) => ({
        rank: i + 1,
        breakout: formatBreakout(x.sig),
        ...describePair(x.e.pair, x.e.catalysts, x.score, x.sec, now),
      })),
    ),
    nearMisses: results.length
      ? []
      : signals
          .filter((x) => !x.sig.isBreakout)
          .slice(0, 3)
          .map((x) => ({ symbol: x.e.pair.baseToken.symbol, chain: x.e.pair.chainId, url: dexUrl(x.e.pair), breakout: formatBreakout(x.sig) })),
    disclaimer: DISCLAIMER,
  };
}

function formatBreakout(s: BreakoutSignal) {
  return {
    isBreakout: s.isBreakout,
    breakoutScore: s.breakoutScore,
    volumeAcceleration: s.acceleration,
    buyRatio5m: s.buyRatio5m,
    buyRatio1h: s.buyRatio1h,
    m5VolumeUsd: s.m5VolumeUsd,
    m5Txns: s.m5Txns,
    priceChangeM5: s.priceChangeM5,
    washSuspected: s.washSuspected,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Tool 5: compare_watchlist
// ---------------------------------------------------------------------------

export interface WatchlistToken {
  address: string;
  chain?: string;
}

export interface CompareParams {
  tokens: WatchlistToken[];
  defaultChain?: string;
}

export async function compareWatchlist(deps: ToolDeps, p: CompareParams) {
  const now = (deps.now ?? Date.now)();
  if (!p.tokens?.length) throw new Error("tokens must contain at least one address");
  if (p.tokens.length > 60) throw new Error("tokens is limited to 60 entries per call");
  const notFound: { address: string; chain?: string; reason: string }[] = [];

  // 1. Resolve a chain for each token with as few calls as possible.
  const resolved = await mapLimit(p.tokens, 5, async (t) => {
    const address = t.address.trim();
    const explicit = t.chain ?? p.defaultChain;
    if (explicit) return { address, chain: normalizeChain(explicit) };
    if (looksLikeEvmAddress(address)) {
      // EVM address without a chain: ask search which chain holds the deepest pool.
      const hits = (await deps.dex.search(address)).filter((x) => normalizeAddress(x.chainId, x.baseToken.address) === address.toLowerCase());
      const top = hits.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      return { address, chain: top?.chainId };
    }
    return { address, chain: looksLikeSolanaAddress(address) ? "solana" : undefined };
  });

  const byChain = new Map<string, string[]>();
  for (const r of resolved) {
    if (!r.chain) {
      notFound.push({ address: r.address, reason: "Could not determine chain; pass `chain` explicitly" });
      continue;
    }
    byChain.set(r.chain, [...(byChain.get(r.chain) ?? []), r.address]);
  }

  // 2. Batch live pairs: <=30 addresses per call.
  const fetched = await Promise.allSettled([...byChain].map(([c, addrs]) => deps.dex.getTokenPairs(c, addrs)));
  const best = bestPairPerToken(fetched.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
  const ctoKeys = await deps.dex.ctoLatest().then(
    (l) => new Set(l.map((s) => tokenKey(s.chainId, s.tokenAddress))),
    () => new Set<string>(),
  );

  const found: Enriched[] = [];
  for (const [chain, addrs] of byChain) {
    for (const a of addrs) {
      const pair = best.get(tokenKey(chain, a));
      if (!pair) notFound.push({ address: a, chain, reason: "No DexScreener pairs found" });
      else
        found.push({
          pair,
          catalysts: { boosted: (pair.boosts?.active ?? 0) > 0, boostAmount: pair.boosts?.active, cto: ctoKeys.has(secKey(pair)) },
        });
    }
  }

  // 3. Security and ranking.
  // Deep audits (holders, authorities) for modest lists; lite for large ones to respect rate limits.
  const audits = await auditAll(deps, found, found.length <= MAX_AUDITS);
  const rows = found
    .map((e) => {
      const sec = audits.get(secKey(e.pair));
      return { e, sec, score: computeAlphaScore(e.pair, e.catalysts, sec, now) };
    })
    .sort((a, b) => Number(a.score.rejected) - Number(b.score.rejected) || b.score.alphaScore - a.score.alphaScore);

  return {
    generatedAt: new Date(now).toISOString(),
    count: rows.length,
    ranking: flagDuplicateSymbols(rows.map((x, i) => ({ rank: i + 1, ...describePair(x.e.pair, x.e.catalysts, x.score, x.sec, now) }))),
    notFound,
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Tool 6: detect_fresh_births
// ---------------------------------------------------------------------------

export interface FreshParams {
  maxAgeMinutes?: number;
  chain?: string;
  minLiquidityUsd?: number;
  limit?: number;
  includeRisky?: boolean;
  /** How long to wait for security audits before answering (audits keep running and are cached for the next call). Default 12. */
  securityTimeoutSeconds?: number;
}

/** DexScreener search queries that surface the newest pairs on the big meme-coin DEXs. */
const FRESH_QUERIES = ["pumpfun", "pumpswap", "raydium", "uniswap", "aerodrome", "pancakeswap"];
const FRESH_MAX_AUDITS = 40;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Linear map of x from [a,b] onto [0,max], clamped. */
const ramp = (x: number, a: number, b: number, max: number) => clamp01((x - a) / (b - a)) * max;
const r1 = (n: number) => Math.round(n * 10) / 10;

export function tradeLink(pair: DexPair): { label: string; url: string } | undefined {
  const chain = pair.chainId.toLowerCase();
  const addr = pair.baseToken.address;
  const dex = (pair.dexId ?? "").toLowerCase();
  if (chain === "solana") {
    if (dex.includes("pump")) return { label: "Pump.fun", url: `https://pump.fun/coin/${addr}` };
    if (dex.includes("raydium")) return { label: "Raydium", url: `https://raydium.io/swap/?inputMint=sol&outputMint=${addr}` };
    return { label: "Jupiter", url: `https://jup.ag/swap/SOL-${addr}` };
  }
  if (chain === "base") return dex.includes("aerodrome") ? { label: "Aerodrome", url: `https://aerodrome.finance/swap?from=eth&to=${addr}` } : { label: "Uniswap", url: `https://app.uniswap.org/swap?chain=base&outputCurrency=${addr}` };
  if (chain === "ethereum") return { label: "Uniswap", url: `https://app.uniswap.org/swap?chain=mainnet&outputCurrency=${addr}` };
  if (chain === "arbitrum") return { label: "Uniswap", url: `https://app.uniswap.org/swap?chain=arbitrum&outputCurrency=${addr}` };
  if (chain === "bsc") return { label: "PancakeSwap", url: `https://pancakeswap.finance/swap?chain=bsc&outputCurrency=${addr}` };
  if (chain === "ton") return dex.includes("stonfi") || dex.includes("ston") ? { label: "STON.fi", url: `https://app.ston.fi/swap?ft=TON&tt=${addr}` } : { label: "DeDust", url: `https://dedust.io/swap/TON/${addr}` };
  return undefined;
}

export function explorerLink(chain: string, address: string): { label: string; url: string } | undefined {
  const c = chain.toLowerCase();
  const map: Record<string, [string, string]> = {
    solana: ["Solscan", `https://solscan.io/token/${address}`],
    base: ["Basescan", `https://basescan.org/token/${address}`],
    ethereum: ["Etherscan", `https://etherscan.io/token/${address}`],
    bsc: ["BscScan", `https://bscscan.com/token/${address}`],
    arbitrum: ["Arbiscan", `https://arbiscan.io/token/${address}`],
    polygon: ["Polygonscan", `https://polygonscan.com/token/${address}`],
    ton: ["Tonviewer", `https://tonviewer.com/${address}`],
  };
  const e = map[c];
  return e ? { label: e[0], url: e[1] } : undefined;
}

export function extractSocials(pair: DexPair) {
  const socials: { twitter?: string; telegram?: string; discord?: string; websites: string[]; other: { type: string; url: string }[] } = { websites: [], other: [] };
  for (const w of pair.info?.websites ?? []) if (w.url && !socials.websites.includes(w.url)) socials.websites.push(w.url);
  for (const s of pair.info?.socials ?? []) {
    if (!s.url) continue;
    const t = (s.type ?? "").toLowerCase();
    if (t === "twitter" || t === "x") socials.twitter ??= s.url;
    else if (t === "telegram") socials.telegram ??= s.url;
    else if (t === "discord") socials.discord ??= s.url;
    else socials.other.push({ type: t, url: s.url });
  }
  return socials;
}

/**
 * Early Birth Velocity (0-100): how strongly a brand-new pair is being bought in its first minutes.
 * 5m buy dominance (25) + 5m volume vs liquidity (20) + 5m price surge (20) + 5m activity depth (15)
 * + verified socials (10) + freshness (10) + security (+10 SAFE, -5 WARNING, -50 DANGER) - wash-trading penalty.
 */
export function computeBirthVelocity(pair: DexPair, ageMinutes: number, maxAgeMinutes: number, security: SecurityReport | undefined) {
  const m5 = pair.txns?.m5;
  const m5Txns = (m5?.buys ?? 0) + (m5?.sells ?? 0);
  const br = buyRatio(m5?.buys, m5?.sells);
  const liq = pair.liquidity?.usd ?? 0;
  const m5Vol = pair.volume?.m5 ?? 0;
  const volToLiq = liq > 0 ? m5Vol / liq : 0;
  const surge = pair.priceChange?.m5 ?? 0;
  const socials = extractSocials(pair);
  const wash = analyzeWashTrading(pair);

  const buyPts = br === undefined || m5Txns < 3 ? 0 : ramp(br, 0.5, 0.85, 25);
  const volPts = ramp(volToLiq, 0, 0.5, 20);
  const surgePts = ramp(surge, 0, 30, 20);
  const depthPts = ramp(m5Txns, 0, 40, 15);
  const socialPts = (socials.websites.length ? 4 : 0) + (socials.twitter ? 3 : 0) + (socials.telegram ? 3 : 0);
  const freshPts = ramp(maxAgeMinutes - ageMinutes, 0, maxAgeMinutes, 10);
  let secDelta = 0;
  let rejected = false;
  const reasons: string[] = [];
  if (security?.status === "SAFE") {
    secDelta = 10;
    reasons.push("Security audit passed (SAFE)");
  } else if (security?.status === "WARNING") {
    secDelta = -5;
    reasons.push(`Security warning. ${security.verdict}`);
  } else if (security?.status === "DANGER") {
    secDelta = -50;
    rejected = true;
    reasons.push(`REJECTED: security DANGER. ${security.verdict}`);
  } else {
    reasons.push("Security UNVERIFIED (brand-new tokens often have no audit data yet): treat as unsafe");
  }
  if (br !== undefined && m5Txns >= 3) reasons.push(`5m buy dominance ${Math.round(br * 100)}% (${m5Txns} txns)`);
  if (volToLiq > 0) reasons.push(`5m volume is ${r1(volToLiq)}x liquidity`);
  if (surge > 0) reasons.push(`5m price +${r1(surge)}%`);
  if (socialPts) reasons.push("Socials/website listed");
  const raw = buyPts + volPts + surgePts + depthPts + socialPts + freshPts - wash.penalty + secDelta;
  const warnings: string[] = [];
  if (ageMinutes < 3) warnings.push("Minute-0 launch: extreme volatility and the highest rug risk window");
  if (liq > 0 && liq < 5_000) warnings.push(`Thin liquidity ($${Math.round(liq)}): price can be moved easily`);
  if (!liq) warnings.push("Liquidity not reported yet");
  if (m5Txns < 5) warnings.push("Very few transactions so far: velocity is not meaningful yet");
  if (wash.suspected) warnings.push("Volume looks bot-driven (wash trading suspected)");
  return {
    velocityScore: r1(Math.max(0, Math.min(100, raw))),
    rejected,
    breakdown: { buyPressure: r1(buyPts), volumeToLiquidity: r1(volToLiq > 0 ? volPts : 0), priceSurge: r1(surgePts), activityDepth: r1(depthPts), socials: socialPts, freshness: r1(freshPts), manipulationPenalty: -r1(wash.penalty), securityAdjustment: secDelta },
    reasons,
    warnings,
    buyRatio5m: br === undefined ? undefined : round3(br),
    washSuspected: wash.suspected,
  };
}


/**
 * Audits a shortlist with a time budget. EVM audits are batched per chain (one GoPlus request per 20 tokens) and all chains
 * run in parallel. Anything unfinished when the budget expires is reported as UNVERIFIED (fail closed) and flagged
 * `pending`; the audit keeps running and lands in the cache, so the next call returns it.
 */
async function auditShortlist(deps: ToolDeps, items: { chain: string; address: string }[], budgetMs: number) {
  const byChain = new Map<string, string[]>();
  for (const it of items) byChain.set(it.chain.toLowerCase(), [...(byChain.get(it.chain.toLowerCase()) ?? []), it.address]);
  const done = new Map<string, SecurityReport>();
  const work = Promise.all([...byChain].map(async ([chain, addrs]) => {
    const res = await deps.security.auditBatch(chain, addrs);
    for (const [a, r] of res) done.set(tokenKey(chain, a), r);
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, budgetMs)); })]);
  if (timer) clearTimeout(timer);
  let pending = 0;
  const reports = items.map((it) => {
    const r = done.get(tokenKey(it.chain, it.address));
    if (r) return { report: r as SecurityReport | undefined, pending: false };
    pending++;
    return { report: unverified(it.chain.toLowerCase(), it.address, "Audit still running (provider rate limit): treat as unsafe until it completes", "none") as SecurityReport | undefined, pending: true };
  });
  return { reports, pending };
}

export async function detectFreshBirths(deps: ToolDeps, p: FreshParams = {}) {
  const now = (deps.now ?? Date.now)();
  const chain = normalizeChain(p.chain ?? "all");
  const maxAgeMinutes = p.maxAgeMinutes ?? 20;
  const minLiq = p.minLiquidityUsd ?? 0;
  const limit = p.limit ?? 30;
  const includeRisky = p.includeRisky ?? false;
  const warnings: string[] = [];
  const cutoffMs = maxAgeMinutes * 60_000;

  // ---- 1. discovery, all sources in parallel (any one may fail)
  const geckoChains = Object.keys(GECKO_NETWORKS).filter((c) => chain === "all" || c === chain);
  const [feeds, gecko, searches] = await Promise.all([
    collectCandidates(deps.dex, chain, 500).then((d) => d, (e) => ({ candidates: [] as Candidate[], warnings: [`DexScreener feeds unavailable: ${e instanceof Error ? e.message : String(e)}`] })),
    deps.gecko
      ? Promise.allSettled(geckoChains.map((c) => deps.gecko!.newPools(c)))
      : Promise.resolve([] as PromiseSettledResult<GeckoPool[]>[]),
    Promise.allSettled(FRESH_QUERIES.map((q) => deps.dex.search(q))),
  ]);
  warnings.push(...feeds.warnings);
  if (!deps.gecko) warnings.push("GeckoTerminal client not configured: new_pools source skipped");
  const geckoPools: GeckoPool[] = [];
  gecko.forEach((r, i) => {
    if (r.status === "fulfilled") geckoPools.push(...r.value);
    else warnings.push(`GeckoTerminal ${geckoChains[i]} new_pools unavailable: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });
  const searchPairs = searches.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).filter((pair) => chain === "all" || pair.chainId.toLowerCase() === chain);

  const merged = new Map<string, Candidate>(feeds.candidates.map((c) => [tokenKey(c.chainId, c.tokenAddress), c]));
  const addSource = (chainId: string, address: string, source: string) => {
    const key = tokenKey(chainId, address);
    const cur = merged.get(key) ?? { chainId: chainId.toLowerCase(), tokenAddress: address, sources: [], boostAmount: 0, cto: false };
    if (!cur.sources.includes(source)) cur.sources.push(source);
    merged.set(key, cur);
  };
  const freshGecko = geckoPools.filter((g) => g.createdAt !== undefined && now - g.createdAt <= cutoffMs);
  for (const g of freshGecko) addSource(g.chainId, g.baseToken.address, "gecko_new_pools");
  for (const sp of searchPairs) if (sp.pairCreatedAt && now - sp.pairCreatedAt <= cutoffMs) addSource(sp.chainId, sp.baseToken.address, "dexscreener_search");

  // ---- 2. authoritative DexScreener pair stats for every candidate, then merge GeckoTerminal-only pools
  const enriched = await fetchCandidatePairs(deps.dex, [...merged.values()]).catch((e) => {
    warnings.push(`DexScreener pair lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return [] as Enriched[];
  });
  type Row = { pair: DexPair; catalysts: Catalysts; source: "dexscreener" | "geckoterminal"; discovery: string[] };
  const rows = new Map<string, Row>();
  for (const e of enriched) rows.set(tokenKey(e.pair.chainId, e.pair.baseToken.address), { pair: e.pair, catalysts: e.catalysts, source: "dexscreener", discovery: merged.get(tokenKey(e.pair.chainId, e.pair.baseToken.address))?.sources ?? [] });
  // search results are full pairs: use them when tokens/v1 had nothing (e.g. just indexed)
  for (const sp of searchPairs) {
    const key = tokenKey(sp.chainId, sp.baseToken.address);
    if (!rows.has(key) && sp.pairCreatedAt && now - sp.pairCreatedAt <= cutoffMs) rows.set(key, { pair: sp, catalysts: { boosted: (sp.boosts?.active ?? 0) > 0, cto: false }, source: "dexscreener", discovery: ["dexscreener_search"] });
  }
  const geckoImage = new Map<string, string>();
  for (const g of geckoPools) if (g.baseToken.imageUrl) geckoImage.set(tokenKey(g.chainId, g.baseToken.address), g.baseToken.imageUrl);
  for (const g of freshGecko) {
    const key = tokenKey(g.chainId, g.baseToken.address);
    if (!rows.has(key)) rows.set(key, { pair: geckoPoolToPair(g), catalysts: { boosted: false, cto: false }, source: "geckoterminal", discovery: ["gecko_new_pools"] });
    else {
      const r = rows.get(key)!;
      if (!r.discovery.includes("gecko_new_pools")) r.discovery.push("gecko_new_pools");
      // GeckoTerminal indexes pools earlier than DexScreener: keep the earlier creation time
      if (g.createdAt !== undefined && (r.pair.pairCreatedAt === undefined || g.createdAt < r.pair.pairCreatedAt)) r.pair = { ...r.pair, pairCreatedAt: g.createdAt };
    }
  }

  // ---- 3. age window + liquidity floor, freshest first
  const fresh = [...rows.values()]
    .map((r) => ({ ...r, ageSec: r.pair.pairCreatedAt ? Math.max(0, Math.round((now - r.pair.pairCreatedAt) / 1000)) : undefined }))
    .filter((r) => r.ageSec !== undefined && r.ageSec <= maxAgeMinutes * 60 && (r.pair.liquidity?.usd ?? 0) >= minLiq)
    .sort((a, b) => a.ageSec! - b.ageSec!);

  // ---- 4. instant security check on the freshest candidates, then score
  const shortlist = fresh.slice(0, Math.min(FRESH_MAX_AUDITS, Math.max(limit * 2, limit)));
  const { reports: audits, pending: auditsPending } = await auditShortlist(deps, shortlist.map((r) => ({ chain: r.pair.chainId, address: r.pair.baseToken.address })), (p.securityTimeoutSeconds ?? 12) * 1000);
  if (auditsPending) warnings.push(`${auditsPending} security audit(s) are still running (provider rate limits): those tokens are UNVERIFIED for now, call again in a few seconds`);
  const scored = shortlist.map((r, i) => {
    const sec = audits[i]!.report;
    const ageMinutes = r1(r.ageSec! / 60);
    const v = computeBirthVelocity(r.pair, r.ageSec! / 60, maxAgeMinutes, sec);
    const pair = r.pair;
    const image = pair.info?.imageUrl ?? geckoImage.get(tokenKey(pair.chainId, pair.baseToken.address)) ?? null;
    const trade = tradeLink(pair);
    const explorer = explorerLink(pair.chainId, pair.baseToken.address);
    const dexscreenerUrl = dexUrl(pair);
    const w = analyzeWashTrading(pair);
    return {
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
      chain: pair.chainId,
      tokenAddress: pair.baseToken.address,
      pairAddress: pair.pairAddress,
      dex: pair.dexId,
      quote: pair.quoteToken?.symbol,
      imageUrl: image,
      ageSeconds: r.ageSec!,
      ageMinutes,
      isMinuteZero: r.ageSec! < 180,
      pairCreatedAt: pair.pairCreatedAt!,
      pairCreatedAtIso: new Date(pair.pairCreatedAt!).toISOString(),
      /** Exact string from the API; never reformat. */
      priceUsd: pair.priceUsd,
      marketCap: pair.marketCap,
      fdv: pair.fdv,
      liquidityUsd: pair.liquidity?.usd,
      volumeUsd: { m5: pair.volume?.m5, h1: pair.volume?.h1, h24: pair.volume?.h24 },
      priceChangePct: { m5: pair.priceChange?.m5, h1: pair.priceChange?.h1, h6: pair.priceChange?.h6, h24: pair.priceChange?.h24 },
      txns: { m5: pair.txns?.m5, h1: pair.txns?.h1 },
      buyRatio: { m5: v.buyRatio5m, h1: round3(buyRatio(pair.txns?.h1?.buys, pair.txns?.h1?.sells)) },
      velocityScore: v.velocityScore,
      scoreBreakdown: v.breakdown,
      reasons: v.reasons,
      warnings: v.warnings,
      rejected: v.rejected,
      tradeQuality: { avgTradeUsd1h: w.avgTradeUsd, txns1h: w.txns1h, volumeToLiquidity1h: w.volumeToLiquidity, washSuspected: w.suspected },
      security: securitySummary(sec),
      auditPending: audits[i]!.pending,
      socials: extractSocials(pair),
      dexscreenerUrl,
      tradeUrl: trade?.url ?? dexscreenerUrl,
      tradeLabel: trade?.label ?? "DexScreener",
      explorerUrl: explorer?.url ?? null,
      explorerLabel: explorer?.label ?? null,
      source: r.source,
      discovery: r.discovery,
      catalysts: r.catalysts,
    };
  });
  const results = flagDuplicateSymbols(scored.filter((x) => includeRisky || !x.rejected))
    .sort((a, b) => a.ageSeconds - b.ageSeconds)
    .slice(0, limit)
    .map((x, i) => ({ rank: i + 1, ...x }));

  return {
    generatedAt: new Date(now).toISOString(),
    filters: { chain, maxAgeMinutes, minLiquidityUsd: minLiq, limit, includeRisky },
    stats: {
      candidates: merged.size,
      geckoNewPools: geckoPools.length,
      pairsFetched: enriched.length,
      withinWindow: fresh.length,
      minuteZero: fresh.filter((x) => x.ageSec! < 180).length,
      audited: shortlist.length - auditsPending,
      auditsPending,
      returned: results.length,
    },
    warnings,
    results,
    disclaimer: DISCLAIMER,
  };
}
