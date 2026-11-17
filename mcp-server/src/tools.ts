import { looksLikeAddress, looksLikeEvmAddress, looksLikeSolanaAddress, normalizeAddress, normalizeChain, tokenKey } from "./chains.js";
import { bestPairPerToken, dexUrl, type DexScreenerClient } from "./dexscreener.js";
import { mapLimit } from "./limiter.js";
import { buyRatio, computeAlphaScore, detectBreakout, pairAgeHours, type BreakoutSignal } from "./scoring.js";
import type { SecurityAuditor } from "./security.js";
import type { AlphaScore, Catalysts, DexPair, DexTokenSignal, SecurityReport } from "./types.js";

export interface ToolDeps {
  dex: DexScreenerClient;
  security: SecurityAuditor;
  now?: () => number;
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
    security: securitySummary(security),
  };
}

function round3(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.round(n * 1000) / 1000;
}

async function auditAll(deps: ToolDeps, items: Enriched[], deep = false): Promise<Map<string, SecurityReport>> {
  const reports = await mapLimit(items, AUDIT_CONCURRENCY, (e) => deps.security.audit(e.pair.chainId, e.pair.baseToken.address, { deep }));
  return new Map(items.map((e, i) => [tokenKey(e.pair.chainId, e.pair.baseToken.address), reports[i]!]));
}

const secKey = (p: DexPair) => tokenKey(p.chainId, p.baseToken.address);

// ---------------------------------------------------------------------------
// Tool 1: scan_opportunities
// ---------------------------------------------------------------------------

export interface ScanParams {
  chain?: string;
  minLiquidityUsd?: number;
  maxAgeHours?: number;
  includeRisky?: boolean;
  limit?: number;
}

export async function scanOpportunities(deps: ToolDeps, p: ScanParams = {}) {
  const now = (deps.now ?? Date.now)();
  const chain = normalizeChain(p.chain ?? "all");
  const minLiq = p.minLiquidityUsd ?? 15_000;
  const maxAge = p.maxAgeHours ?? 72;
  const limit = p.limit ?? 10;
  const includeRisky = p.includeRisky ?? false;

  const { candidates, warnings } = await collectCandidates(deps.dex, chain);
  const enriched = await fetchCandidatePairs(deps.dex, candidates);
  const filtered = enriched.filter(({ pair }) => {
    if ((pair.liquidity?.usd ?? 0) < minLiq) return false;
    const age = pairAgeHours(pair, now);
    return age !== undefined && age <= maxAge;
  });

  // Pre-rank without security, audit only the strongest, then re-rank.
  const prelim = filtered
    .map((e) => ({ e, s: computeAlphaScore(e.pair, e.catalysts).alphaScore }))
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.min(MAX_AUDITS, Math.max(limit * 2, limit)))
    .map((x) => x.e);
  const audits = await auditAll(deps, prelim);

  const scored = prelim
    .map((e) => {
      const sec = audits.get(secKey(e.pair));
      return { e, sec, score: computeAlphaScore(e.pair, e.catalysts, sec) };
    })
    .filter((x) => includeRisky || !x.score.rejected)
    .sort((a, b) => Number(a.score.rejected) - Number(b.score.rejected) || b.score.alphaScore - a.score.alphaScore)
    .slice(0, limit);

  return {
    generatedAt: new Date(now).toISOString(),
    filters: { chain, minLiquidityUsd: minLiq, maxAgeHours: maxAge, includeRisky, limit },
    stats: {
      candidates: candidates.length,
      pairsFetched: enriched.length,
      passedFilters: filtered.length,
      audited: prelim.length,
      returned: scored.length,
    },
    warnings,
    results: scored.map((x, i) => ({ rank: i + 1, ...describePair(x.e.pair, x.e.catalysts, x.score, x.sec, now) })),
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
  const score = computeAlphaScore(best, catalysts, security);

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

  const results = hits
    .map((h) => {
      const sec = audits.get(secKey(h.e.pair));
      return { ...h, sec, score: computeAlphaScore(h.e.pair, h.e.catalysts, sec) };
    })
    .filter((x) => includeRisky || !x.score.rejected)
    .slice(0, limit);

  return {
    generatedAt: new Date(now).toISOString(),
    filters: { chain, minLiquidityUsd: minLiq, maxAgeHours: maxAge, includeRisky, limit, thresholds: { minAcceleration: p.minAcceleration ?? 2, minBuyRatio: p.minBuyRatio ?? 0.6 } },
    stats: { candidates: candidates.length, scanned: pool.length, breakouts: signals.filter((x) => x.sig.isBreakout).length, returned: results.length },
    warnings,
    results: results.map((x, i) => ({
      rank: i + 1,
      breakout: formatBreakout(x.sig),
      ...describePair(x.e.pair, x.e.catalysts, x.score, x.sec, now),
    })),
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
  const audits = await auditAll(deps, found);
  const rows = found
    .map((e) => {
      const sec = audits.get(secKey(e.pair));
      return { e, sec, score: computeAlphaScore(e.pair, e.catalysts, sec) };
    })
    .sort((a, b) => Number(a.score.rejected) - Number(b.score.rejected) || b.score.alphaScore - a.score.alphaScore);

  return {
    generatedAt: new Date(now).toISOString(),
    count: rows.length,
    ranking: rows.map((x, i) => ({ rank: i + 1, ...describePair(x.e.pair, x.e.catalysts, x.score, x.sec, now) })),
    notFound,
    disclaimer: DISCLAIMER,
  };
}
