/**
 * evaluate_narrative_pulse: narrative momentum, copycat risk and social presence.
 *
 * What this can and cannot see: DexScreener exposes market data and the project's listed
 * links, not social posts. "Narrative momentum" is therefore built from market attention
 * (trending-source presence, volume acceleration, buy pressure, price trend, catalysts)
 * and listing quality, and the output says so. Social links are format-checked, not
 * verified against the real accounts.
 */
import { tokenKey } from "../chains.js";
import { dexUrl } from "../dexscreener.js";
import { analyzeWashTrading, buyRatio, volumeVelocity } from "../scoring.js";
import type { DexPair } from "../types.js";
import { collectCandidates, DISCLAIMER, fetchCandidatePairs, resolveTokenMatches, type ToolDeps } from "./index.js";

export type CopycatRisk = "NONE" | "LOW" | "MEDIUM" | "HIGH";
export type NarrativeVerdict = "STRONG_NARRATIVE" | "MODERATE_NARRATIVE" | "WEAK_NARRATIVE" | "LATE_COPYCAT";

/** Minutes between launches before one token is considered "earlier" than another. */
export const EARLIER_GAP_MIN = 30;
/** Name/symbol similarity at or above this counts as the same narrative. */
export const MATCH_THRESHOLD = 0.75;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const lerp = (x: number, a: number, b: number, c: number, d: number) => c + ((clamp(x, a, b) - a) / (b - a)) * (d - c);
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Name / symbol similarity
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(["coin", "token", "the", "of", "on", "official", "new", "and", "a", "in", "to", "sol", "solana", "eth", "base", "bsc", "v2", "v3"]);

export function symbolKey(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export interface NameSimilarity {
  score: number;
  reasons: string[];
  /** The tokens' names (not just their tickers) match. Tickers are not unique; names are the stronger signal. */
  nameMatch: boolean;
  /** The tickers match or nearly match. */
  symbolMatch: boolean;
}

/** 0-1 similarity of two tokens' symbol and name, with human-readable reasons. */
export function similarity(a: { symbol: string; name: string }, b: { symbol: string; name: string }): NameSimilarity {
  const reasons: string[] = [];
  let score = 0;
  let nameMatch = false;
  let symbolMatch = false;
  const sa = symbolKey(a.symbol);
  const sb = symbolKey(b.symbol);
  if (sa.length >= 2 && sa === sb) {
    score = 1;
    symbolMatch = true;
    reasons.push("same symbol");
  } else if (sa.length >= 4 && sb.length >= 4) {
    const sim = 1 - levenshtein(sa, sb) / Math.max(sa.length, sb.length);
    if (sim >= 0.8) {
      score = Math.max(score, sim);
      symbolMatch = true;
      reasons.push(`similar symbol (${Math.round(sim * 100)}%)`);
    }
  }
  const wa = nameWords(a.name);
  const wb = nameWords(b.name);
  if (wa.length && wb.length) {
    const A = new Set(wa);
    const B = new Set(wb);
    const inter = [...A].filter((w) => B.has(w)).length;
    const jaccard = inter / (A.size + B.size - inter);
    if (jaccard === 1) {
      score = Math.max(score, 1);
      nameMatch = true;
      reasons.push("same name");
    } else if (jaccard >= MATCH_THRESHOLD) {
      score = Math.max(score, jaccard);
      nameMatch = true;
      reasons.push(`name overlap (${Math.round(jaccard * 100)}%)`);
    } else {
      // One name fully contained in the other and distinctive enough ("pepe" in "pepe 2.0").
      const [small, big] = A.size <= B.size ? [A, B] : [B, A];
      const contained = [...small].every((w) => big.has(w));
      if (contained && [...small].join("").length >= 5) {
        score = Math.max(score, 0.8);
        nameMatch = true;
        reasons.push("name contains the other's name");
      }
    }
  }
  return { score: Math.round(score * 100) / 100, reasons, nameMatch, symbolMatch };
}

// ---------------------------------------------------------------------------
// Copycat evaluation (pure)
// ---------------------------------------------------------------------------

export interface TokenRef {
  symbol: string;
  name: string;
  chain: string;
  tokenAddress: string;
  /** Pair creation time, ms epoch. */
  createdAt?: number;
  liquidityUsd: number;
  volumeH24: number;
  boosted: boolean;
  /** Seen in DexScreener's trending sources (boosts, profiles, CTOs). */
  trending: boolean;
  url?: string;
}

export function toRef(pair: DexPair, trending: boolean, boosted = false): TokenRef {
  return {
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    chain: pair.chainId,
    tokenAddress: pair.baseToken.address,
    createdAt: pair.pairCreatedAt,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    volumeH24: pair.volume?.h24 ?? 0,
    boosted: boosted || (pair.boosts?.active ?? 0) > 0,
    trending,
    url: dexUrl(pair),
  };
}

export type Relation = "EARLIER_ORIGINAL" | "EARLIER_SMALLER" | "EARLIER_SAME_TICKER" | "EARLIER_DEFUNCT" | "LATER_CLONE" | "CONTEMPORARY";

/**
 * An earlier token only counts as a living "original" if it still has a market. DexScreener's
 * profile/boost feeds also list old, dead tokens whose profile was merely updated, so appearing
 * there is not enough on its own.
 */
export const DEFUNCT_BELOW_USD = 2_000;
/** An earlier look-alike must reach this fraction of the subject's liquidity or volume to count as a credible original. */
export const COMPETITIVE_RATIO = 0.5;

export interface CopycatMatch {
  symbol: string;
  name: string;
  chain: string;
  tokenAddress: string;
  similarity: number;
  why: string[];
  relation: Relation;
  /** Minutes the other token launched before (+) or after (-) the subject. */
  launchedMinutesEarlier?: number;
  liquidityUsd: number;
  volumeH24: number;
  trending: boolean;
  url?: string;
}

export interface CopycatAssessment {
  risk: CopycatRisk;
  /** True when no earlier similar token exists. */
  isLikelyOriginal: boolean;
  matches: CopycatMatch[];
  summary: string;
}

/**
 * A subject is a late copycat when an earlier, similarly named token is larger or trending.
 * Tickers are NOT unique (hundreds of unrelated tokens share any popular ticker), so a ticker-only
 * match is never called an "original" unless that older token is itself trending or boosted.
 *  HIGH   earlier + (name match and larger, or trending/boosted)
 *  MEDIUM earlier but smaller; an older token with only the same ticker (possibly unrelated);
 *         or an ambiguous near-identical token launched around the same time
 *  LOW    only later clones exist (the subject looks like the original)
 *  NONE   nothing similar found
 */
export function evaluateCopycat(subject: TokenRef, refs: TokenRef[]): CopycatAssessment {
  const matches: CopycatMatch[] = [];
  for (const r of refs) {
    if (tokenKey(r.chain, r.tokenAddress) === tokenKey(subject.chain, subject.tokenAddress)) continue;
    const sim = similarity(subject, r);
    if (sim.score < MATCH_THRESHOLD) continue;
    const gap = subject.createdAt !== undefined && r.createdAt !== undefined ? (subject.createdAt - r.createdAt) / 60_000 : undefined;
    // An earlier token is a credible "original" only if it is a comparable market: at least half the
    // subject's liquidity or 24h volume. A much smaller older token is not what holders would pick instead.
    const dominant = r.liquidityUsd >= subject.liquidityUsd * COMPETITIVE_RATIO || r.volumeH24 >= subject.volumeH24 * COMPETITIVE_RATIO;
    const attention = r.trending || r.boosted;
    let relation: Relation;
    const defunct = r.liquidityUsd < DEFUNCT_BELOW_USD && r.volumeH24 < DEFUNCT_BELOW_USD;
    if (gap !== undefined && gap >= EARLIER_GAP_MIN) {
      if (defunct) relation = "EARLIER_DEFUNCT";
      else if (sim.nameMatch) relation = dominant ? "EARLIER_ORIGINAL" : "EARLIER_SMALLER";
      else relation = attention && dominant ? "EARLIER_ORIGINAL" : "EARLIER_SAME_TICKER";
    } else if (gap !== undefined && gap <= -EARLIER_GAP_MIN) relation = "LATER_CLONE";
    else relation = "CONTEMPORARY";
    matches.push({
      symbol: r.symbol,
      name: r.name,
      chain: r.chain,
      tokenAddress: r.tokenAddress,
      similarity: sim.score,
      why: sim.reasons,
      relation,
      launchedMinutesEarlier: gap === undefined ? undefined : Math.round(gap),
      liquidityUsd: r.liquidityUsd,
      volumeH24: r.volumeH24,
      trending: r.trending,
      url: r.url,
    });
  }
  matches.sort((a, b) => b.similarity - a.similarity || b.liquidityUsd - a.liquidityUsd);

  const has = (rel: Relation) => matches.some((m) => m.relation === rel);
  const ambiguous = matches.some((m) => m.relation === "CONTEMPORARY" && m.similarity >= 0.95 && (m.liquidityUsd >= subject.liquidityUsd || m.trending));
  let risk: CopycatRisk;
  let summary: string;
  if (has("EARLIER_ORIGINAL")) {
    risk = "HIGH";
    const o = matches.find((m) => m.relation === "EARLIER_ORIGINAL")!;
    summary = `Likely late copycat of $${o.symbol} "${o.name}" (${o.chain}; matched on ${o.why.join(" + ")}), which launched ${o.launchedMinutesEarlier} min earlier${o.trending ? " and is trending" : ""} with $${Math.round(o.liquidityUsd)} liquidity and $${Math.round(o.volumeH24)} 24h volume`;
  } else if (has("EARLIER_SMALLER") || has("EARLIER_SAME_TICKER") || ambiguous) {
    risk = "MEDIUM";
    const t = matches.find((m) => m.relation === "EARLIER_SAME_TICKER");
    summary = ambiguous
      ? "A near-identical token launched around the same time: which one is the original is unclear"
      : has("EARLIER_SMALLER")
        ? "Similar tokens launched earlier, but they are smaller and not trending"
        : `An older token shares the ticker but not the name ($${t!.symbol} "${t!.name}", ${t!.launchedMinutesEarlier} min earlier): possibly unrelated, verify the project`;
  } else if (has("LATER_CLONE") || matches.length) {
    risk = "LOW";
    const dead = matches.filter((m) => m.relation === "EARLIER_DEFUNCT").length;
    summary = `No living earlier similar token found; ${matches.length} look-alike(s) exist (later, contemporary${dead ? `, or ${dead} defunct with under $${DEFUNCT_BELOW_USD} liquidity and volume` : ""})`;
  } else {
    risk = "NONE";
    summary = "No similar tokens found among trending tokens or same-ticker pools";
  }
  return { risk, isLikelyOriginal: !has("EARLIER_ORIGINAL") && !has("EARLIER_SMALLER"), matches, summary };
}

// ---------------------------------------------------------------------------
// Social presence (pure)
// ---------------------------------------------------------------------------

const hostOf = (u: string): string | undefined => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
};
const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
const TG_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);
const SOCIAL_HOSTS = new Set([...X_HOSTS, ...TG_HOSTS, "discord.gg", "discord.com", "linktr.ee", "facebook.com", "instagram.com", "tiktok.com", "youtube.com"]);

export interface SocialPresence {
  website: { listed: boolean; url?: string; valid: boolean };
  x: { listed: boolean; url?: string; valid: boolean };
  telegram: { listed: boolean; url?: string; valid: boolean };
  /** 0-100: website 30, X 40, Telegram 30 (full credit only for format-valid links). */
  score: number;
  issues: string[];
  /** What "verified" means here. */
  verification: string;
}

export function evaluateSocials(pairs: DexPair[]): SocialPresence {
  const websites = pairs.flatMap((p) => p.info?.websites ?? []).map((w) => w.url).filter(Boolean);
  const socials = pairs.flatMap((p) => p.info?.socials ?? []).filter((s) => s.url);
  const find = (...types: string[]) => socials.find((s) => types.includes((s.type ?? "").toLowerCase()))?.url;
  const issues: string[] = [];

  const siteUrl = websites[0];
  const siteHost = siteUrl ? hostOf(siteUrl) : undefined;
  const siteValid = !!siteUrl && /^https:\/\//i.test(siteUrl) && !!siteHost && !SOCIAL_HOSTS.has(siteHost);
  if (siteUrl && !siteValid) issues.push(!/^https:\/\//i.test(siteUrl) ? "Website is not HTTPS" : "Website link points to a social/linktree page, not a project site");

  const xUrl = find("twitter", "x");
  const xHost = xUrl ? hostOf(xUrl) : undefined;
  const xValid = !!xUrl && !!xHost && X_HOSTS.has(xHost) && (new URL(xUrl).pathname.replace(/\//g, "").length > 0);
  if (xUrl && !xValid) issues.push("X/Twitter link is not a valid x.com / twitter.com profile URL");

  const tgUrl = find("telegram");
  const tgHost = tgUrl ? hostOf(tgUrl) : undefined;
  const tgValid = !!tgUrl && !!tgHost && TG_HOSTS.has(tgHost) && (new URL(tgUrl).pathname.replace(/\//g, "").length > 0);
  if (tgUrl && !tgValid) issues.push("Telegram link is not a valid t.me URL");

  const pts = (listed: boolean, valid: boolean, full: number) => (valid ? full : listed ? full / 2 : 0);
  return {
    website: { listed: !!siteUrl, url: siteUrl, valid: siteValid },
    x: { listed: !!xUrl, url: xUrl, valid: xValid },
    telegram: { listed: !!tgUrl, url: tgUrl, valid: tgValid },
    score: Math.round(pts(!!siteUrl, siteValid, 30) + pts(!!xUrl, xValid, 40) + pts(!!tgUrl, tgValid, 30)),
    issues,
    verification: "Links come from the token's DexScreener listing and are checked for the right host and shape. The accounts themselves are not independently verified.",
  };
}

// ---------------------------------------------------------------------------
// Narrative momentum (pure)
// ---------------------------------------------------------------------------

export interface MomentumInput {
  pair: DexPair;
  /** How many of DexScreener's trending sources list the token (0-4). */
  trendingSources: number;
  boosted: boolean;
  cto: boolean;
  socialScore: number;
}

export interface NarrativeMomentum {
  score: number;
  components: { trending: number; volume: number; buyPressure: number; priceTrend: number; catalysts: number; social: number; washPenalty: number };
  reasons: string[];
}

export function narrativeMomentum(i: MomentumInput): NarrativeMomentum {
  const p = i.pair;
  const reasons: string[] = [];
  const trending = Math.min(20, i.trendingSources * 5);
  if (i.trendingSources) reasons.push(`Listed in ${i.trendingSources} DexScreener attention source(s)`);

  const { acceleration, turnover } = volumeVelocity(p);
  const volume = lerp(acceleration, 0.5, 3, 0, 18) + lerp(turnover, 0, 3, 0, 7);
  if (acceleration > 1.5) reasons.push(`5m volume running ${acceleration.toFixed(1)}x the 1h pace`);

  const conf = (w: "m5" | "h1", n: number) => clamp(((p.txns?.[w]?.buys ?? 0) + (p.txns?.[w]?.sells ?? 0)) / n, 0, 1);
  const r5 = buyRatio(p.txns?.m5?.buys, p.txns?.m5?.sells);
  const r1h = buyRatio(p.txns?.h1?.buys, p.txns?.h1?.sells);
  const buyPressure = (r5 === undefined ? 0 : lerp(r5, 0.45, 0.75, 0, 10) * conf("m5", 8)) + (r1h === undefined ? 0 : lerp(r1h, 0.45, 0.7, 0, 10) * conf("h1", 30));
  if ((r1h ?? 0) > 0.6) reasons.push(`Buyers dominate (${Math.round((r1h ?? 0) * 100)}% of 1h trades)`);

  const priceTrend = lerp(p.priceChange?.h1 ?? 0, -10, 40, 0, 8) + lerp(p.priceChange?.h24 ?? 0, -20, 100, 0, 7);
  const catalysts = (i.boosted ? 5 : 0) + (i.cto ? 5 : 0);
  if (i.boosted) reasons.push("Active DexScreener boost");
  if (i.cto) reasons.push("Community takeover");
  const social = (i.socialScore / 100) * 10;

  // Volume that looks fake is not attention.
  const wash = analyzeWashTrading(p);
  const raw = trending + volume + buyPressure + priceTrend + catalysts + social - wash.penalty;
  if (wash.suspected) reasons.push(...wash.warnings);
  return {
    score: r1(clamp(raw, 0, 100)),
    components: {
      trending: r1(trending),
      volume: r1(volume),
      buyPressure: r1(buyPressure),
      priceTrend: r1(priceTrend),
      catalysts,
      social: r1(social),
      washPenalty: wash.penalty === 0 ? 0 : -wash.penalty,
    },
    reasons,
  };
}

export function themeKeywords(subject: { symbol: string; name: string }): string[] {
  const words = new Set(nameWords(subject.name));
  const sym = symbolKey(subject.symbol);
  if (sym.length >= 3 && !STOPWORDS.has(sym)) words.add(sym);
  return [...words].slice(0, 6);
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface NarrativePulseParams {
  /** Symbol, name or contract address. */
  query: string;
  chain?: string;
}

const MAX_TRENDING_REFS = 60;

export async function evaluateNarrativePulse(deps: ToolDeps, p: NarrativePulseParams) {
  const now = (deps.now ?? Date.now)();
  const warnings: string[] = [];
  const { tokens } = await resolveTokenMatches(deps, p.query, p.chain);
  if (!tokens.length) {
    return { found: false as const, query: p.query, message: `No DexScreener pools found for "${p.query}".`, disclaimer: DISCLAIMER };
  }
  const pools = tokens[0]!;
  const pair = pools[0]!;
  const subjectKey = tokenKey(pair.chainId, pair.baseToken.address);

  // Reference set 1: what DexScreener is surfacing right now (boosts, profiles, CTOs).
  let trendingSources = 0;
  let boosted = (pair.boosts?.active ?? 0) > 0;
  let cto = false;
  const refs = new Map<string, TokenRef>();
  try {
    const { candidates, warnings: w } = await collectCandidates(deps.dex, "all", MAX_TRENDING_REFS);
    warnings.push(...w);
    const me = candidates.find((c) => tokenKey(c.chainId, c.tokenAddress) === subjectKey);
    if (me) {
      trendingSources = me.sources.length;
      boosted = boosted || me.boostAmount > 0;
      cto = me.cto;
    }
    const others = candidates.filter((c) => tokenKey(c.chainId, c.tokenAddress) !== subjectKey).slice(0, MAX_TRENDING_REFS);
    for (const e of await fetchCandidatePairs(deps.dex, others)) {
      const cand = others.find((c) => tokenKey(c.chainId, c.tokenAddress) === tokenKey(e.pair.chainId, e.pair.baseToken.address));
      refs.set(tokenKey(e.pair.chainId, e.pair.baseToken.address), toRef(e.pair, true, e.catalysts.boosted || (cand?.boostAmount ?? 0) > 0));
    }
  } catch (e) {
    warnings.push(`Trending comparison unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Reference set 2: every other token sharing the symbol/name across all DEX pools.
  for (const list of tokens.slice(1)) {
    const top = list[0]!;
    const k = tokenKey(top.chainId, top.baseToken.address);
    if (!refs.has(k)) refs.set(k, toRef(top, false));
  }
  // Same-ticker search for address queries (the query itself would only return the subject).
  try {
    for (const hit of await deps.dex.search(pair.baseToken.symbol)) {
      const k = tokenKey(hit.chainId, hit.baseToken.address);
      if (k === subjectKey) continue;
      const prev = refs.get(k);
      if (!prev || (hit.liquidity?.usd ?? 0) > prev.liquidityUsd) refs.set(k, toRef(hit, prev?.trending ?? false, prev?.boosted ?? false));
    }
  } catch {
    warnings.push("Same-ticker search unavailable");
  }

  const subject = toRef(pair, trendingSources > 0, boosted);
  const copycat = evaluateCopycat(subject, [...refs.values()]);
  const social = evaluateSocials(pools);
  const momentum = narrativeMomentum({ pair, trendingSources, boosted, cto, socialScore: social.score });

  // Theme crowding: how many trending tokens share this narrative's keywords.
  const keywords = themeKeywords({ symbol: pair.baseToken.symbol, name: pair.baseToken.name });
  const theme = keywords
    .map((k) => {
      const peers = [...refs.values()].filter((r) => r.trending && (nameWords(r.name).includes(k) || symbolKey(r.symbol) === k));
      return { keyword: k, trendingPeers: peers.length, examples: peers.slice(0, 3).map((r) => `$${r.symbol}`) };
    })
    .filter((t) => t.trendingPeers > 0);
  const crowded = theme.find((t) => t.trendingPeers >= 4);
  if (crowded) warnings.push(`Crowded theme: ${crowded.trendingPeers} trending tokens share "${crowded.keyword}"`);

  if (copycat.risk === "HIGH" || copycat.risk === "MEDIUM") warnings.push(copycat.summary);
  for (const i of social.issues) warnings.push(i);
  if (!social.website.listed) warnings.push("No website listed");
  if (!social.x.listed) warnings.push("No X/Twitter listed");
  if (!social.telegram.listed) warnings.push("No Telegram listed");
  if (momentum.components.washPenalty < 0) warnings.push("Momentum is discounted because the volume looks bot-driven");

  const verdict: NarrativeVerdict =
    copycat.risk === "HIGH" ? "LATE_COPYCAT" : momentum.score >= 70 && social.score >= 60 && (copycat.risk === "NONE" || copycat.risk === "LOW") ? "STRONG_NARRATIVE" : momentum.score >= 45 ? "MODERATE_NARRATIVE" : "WEAK_NARRATIVE";

  return {
    found: true as const,
    query: p.query,
    generatedAt: new Date(now).toISOString(),
    token: { symbol: pair.baseToken.symbol, name: pair.baseToken.name, chain: pair.chainId, tokenAddress: pair.baseToken.address, url: dexUrl(pair), priceUsd: pair.priceUsd, liquidityUsd: pair.liquidity?.usd },
    verdict,
    catalysts: { boosted, cto, trendingSources },
    /** True when copycat risk is MEDIUM or HIGH: the flag the trading entry rules use. */
    copycatFlag: copycat.risk === "MEDIUM" || copycat.risk === "HIGH",
    momentum,
    copycat: { ...copycat, matches: copycat.matches.slice(0, 8), comparedAgainst: refs.size },
    social,
    theme: { keywords, peers: theme },
    warnings: [...new Set(warnings)],
    dataNotes: "Narrative momentum is derived from market attention (trending sources, volume, buy pressure, price trend, boosts) and listing quality. DexScreener has no social-post data, so tweet or chat volume is not measured.",
    disclaimer: DISCLAIMER,
  };
}
