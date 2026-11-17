import { normalizeAddress, tokenKey } from "./chains.js";
import { fetchJson, type HttpOptions } from "./http.js";
import { chunk, TokenBucket, TtlCache, type Clock, type Sleeper } from "./limiter.js";
import type { DexPair, DexTokenSignal } from "./types.js";

export { TokenBucket, TtlCache, chunk } from "./limiter.js";

export const DEXSCREENER_BASE = "https://api.dexscreener.com";
/** `/tokens/v1/{chainId}/{addresses}` accepts at most 30 comma-separated addresses. */
export const MAX_ADDRESSES_PER_CALL = 30;
export const DEFAULT_CACHE_TTL_MS = 12_000;

/** Documented per-endpoint limits (requests / minute). */
export const ENDPOINT_LIMITS = {
  boostsLatest: 60,
  boostsTop: 60,
  profilesLatest: 60,
  ctoLatest: 60,
  tokens: 300,
  search: 300,
  pairs: 300,
} as const;
export type Endpoint = keyof typeof ENDPOINT_LIMITS;

/**
 * Builds a bucket that stays safely under `limit`/min over any 60 s window:
 * sustained 80% of the limit + a burst of 15% = 95% worst case.
 */
export function bucketForLimit(limit: number, now?: Clock, sleep?: Sleeper): TokenBucket {
  return new TokenBucket({
    capacity: Math.max(1, Math.floor(limit * 0.15)),
    refillPerMinute: Math.max(1, Math.floor(limit * 0.8)),
    now,
    sleep,
  });
}

export interface DexClientOptions extends HttpOptions {
  baseUrl?: string;
  cacheTtlMs?: number;
  now?: Clock;
}

function asArray<T>(x: unknown): T[] {
  if (Array.isArray(x)) return x as T[];
  return x && typeof x === "object" ? [x as T] : [];
}

function assertSafeSegment(label: string, value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  return value;
}

export class DexScreenerClient {
  private readonly baseUrl: string;
  private readonly cache: TtlCache<unknown>;
  private readonly buckets: Record<Endpoint, TokenBucket>;
  private readonly http: HttpOptions;
  /** Number of real network requests issued (cache hits excluded). */
  requestCount = 0;

  constructor(opts: DexClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEXSCREENER_BASE;
    this.cache = new TtlCache(opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, opts.now);
    this.http = {
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      baseDelayMs: opts.baseDelayMs,
    };
    const b = (e: Endpoint) => bucketForLimit(ENDPOINT_LIMITS[e], opts.now, opts.sleep);
    this.buckets = {
      boostsLatest: b("boostsLatest"),
      boostsTop: b("boostsTop"),
      profilesLatest: b("profilesLatest"),
      ctoLatest: b("ctoLatest"),
      tokens: b("tokens"),
      search: b("search"),
      pairs: b("pairs"),
    };
  }

  /** Cache -> pace -> fetch (with backoff). Concurrent identical calls share one request. */
  private get<T>(endpoint: Endpoint, path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return this.cache.wrap(url, async () => {
      await this.buckets[endpoint].acquire();
      this.requestCount++;
      return fetchJson<unknown>(url, this.http);
    }) as Promise<T>;
  }

  async boostsLatest(): Promise<DexTokenSignal[]> {
    return asArray<DexTokenSignal>(await this.get("boostsLatest", "/token-boosts/latest/v1"));
  }

  async boostsTop(): Promise<DexTokenSignal[]> {
    return asArray<DexTokenSignal>(await this.get("boostsTop", "/token-boosts/top/v1"));
  }

  async profilesLatest(): Promise<DexTokenSignal[]> {
    return asArray<DexTokenSignal>(await this.get("profilesLatest", "/token-profiles/latest/v1"));
  }

  async ctoLatest(): Promise<DexTokenSignal[]> {
    return asArray<DexTokenSignal>(await this.get("ctoLatest", "/community-takeovers/latest/v1"));
  }

  /**
   * Batch pair lookup. Addresses are de-duplicated and split into calls of at most 30.
   * Calls run concurrently; the token bucket paces them.
   */
  async getTokenPairs(chainId: string, addresses: readonly string[]): Promise<DexPair[]> {
    const chain = assertSafeSegment("chainId", chainId);
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const a of addresses) {
      const key = normalizeAddress(chain, a);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(assertSafeSegment("token address", a.trim()));
    }
    const groups = chunk(unique, MAX_ADDRESSES_PER_CALL);
    const results = await Promise.all(
      groups.map((g) => this.get<unknown>("tokens", `/tokens/v1/${chain}/${g.join(",")}`)),
    );
    return results.flatMap((r) => asArray<DexPair>(r)).filter(isUsablePair);
  }

  /** Search pairs by symbol / name / contract address. */
  async search(query: string): Promise<DexPair[]> {
    const q = query.trim();
    if (!q) return [];
    const res = await this.get<{ pairs?: DexPair[] }>("search", `/latest/dex/search?q=${encodeURIComponent(q)}`);
    return (res?.pairs ?? []).filter(isUsablePair);
  }

  /** Fresh stats for a single pair. */
  async getPair(chainId: string, pairId: string): Promise<DexPair | undefined> {
    const chain = assertSafeSegment("chainId", chainId);
    const pair = assertSafeSegment("pairId", pairId);
    const res = await this.get<{ pairs?: DexPair[]; pair?: DexPair | null }>("pairs", `/latest/dex/pairs/${chain}/${pair}`);
    return res?.pair ?? res?.pairs?.[0] ?? undefined;
  }
}

function isUsablePair(p: DexPair | null | undefined): p is DexPair {
  return !!p && typeof p.chainId === "string" && !!p.baseToken?.address && !!p.pairAddress;
}

/** Highest-liquidity pair for each base token, keyed by `chain:address`. */
export function bestPairPerToken(pairs: readonly DexPair[]): Map<string, DexPair> {
  const best = new Map<string, DexPair>();
  for (const p of pairs) {
    const key = tokenKey(p.chainId, p.baseToken.address);
    const cur = best.get(key);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(key, p);
  }
  return best;
}

export function dexUrl(pair: DexPair): string {
  return pair.url ?? `https://dexscreener.com/${pair.chainId}/${pair.pairAddress}`;
}
