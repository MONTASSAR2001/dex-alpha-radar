import { fetchJson, type HttpOptions } from "./http.js";
import { TokenBucket, TtlCache, type Clock, type Sleeper } from "./limiter.js";
import type { DexPair } from "./types.js";

/**
 * Minimal GeckoTerminal v2 client (zero-auth). Used to catch pools in their first minutes: `new_pools` lists a pool
 * the moment it is indexed, often before DexScreener has a pair for it.
 *
 * Free tier budget is about 30 requests/min, so calls are paced and cached.
 */
export const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

/** DexScreener chainId -> GeckoTerminal network slug. */
export const GECKO_NETWORKS: Readonly<Record<string, string>> = {
  solana: "solana",
  base: "base",
  ethereum: "eth",
  bsc: "bsc",
  ton: "ton",
  arbitrum: "arbitrum",
};

const DEFAULT_CACHE_TTL_MS = 20_000;
const STALE_IF_ERROR_MS = 3 * 60_000;

export interface GeckoPool {
  chainId: string;
  poolAddress: string;
  dexId: string;
  baseToken: { address: string; name: string; symbol: string; imageUrl?: string };
  quoteSymbol?: string;
  priceUsd?: string;
  /** Pool creation time (epoch ms). */
  createdAt?: number;
  fdvUsd?: number;
  marketCapUsd?: number;
  reserveUsd?: number;
  volume: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns: Partial<Record<"m5" | "h1" | "h6" | "h24", { buys: number; sells: number; buyers?: number; sellers?: number }>>;
}

export interface GeckoClientOptions extends HttpOptions {
  baseUrl?: string;
  cacheTtlMs?: number;
  now?: Clock;
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const realImage = (u: unknown): string | undefined => (typeof u === "string" && u.startsWith("http") && !/missing/i.test(u) ? u : undefined);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Pure parser: GeckoTerminal `new_pools?include=base_token` response -> normalized pools. Exported for tests. */
export function parseNewPools(chainId: string, slug: string, res: Json): GeckoPool[] {
  const tokens = new Map<string, Json>();
  for (const inc of (res?.included ?? []) as Json[]) if (inc?.type === "token") tokens.set(String(inc.id), inc.attributes ?? {});
  const out: GeckoPool[] = [];
  for (const d of (res?.data ?? []) as Json[]) {
    const a = d.attributes ?? {};
    const baseId = String(d.relationships?.base_token?.data?.id ?? "");
    const address = baseId.startsWith(`${slug}_`) ? baseId.slice(slug.length + 1) : "";
    if (!address || !a.address) continue;
    const tk = tokens.get(baseId) ?? {};
    const name = String(a.name ?? "");
    const [baseSym, quoteSym] = name.split(" / ").map((s) => s.trim());
    const t = a.transactions ?? {};
    const tx = (k: string) => (t[k] ? { buys: num(t[k].buys) ?? 0, sells: num(t[k].sells) ?? 0, buyers: num(t[k].buyers), sellers: num(t[k].sellers) } : undefined);
    const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
    out.push({
      chainId,
      poolAddress: String(a.address),
      dexId: String(d.relationships?.dex?.data?.id ?? "").replace(/-(v\d+|base|bsc|eth|ethereum|arbitrum)/gi, "") || "unknown",
      baseToken: { address, name: String(tk.name ?? baseSym ?? ""), symbol: String(tk.symbol ?? baseSym ?? "?"), imageUrl: realImage(tk.image_url) },
      quoteSymbol: quoteSym?.replace(/\s+\d+(\.\d+)?%$/, ""),
      priceUsd: a.base_token_price_usd === null || a.base_token_price_usd === undefined ? undefined : String(a.base_token_price_usd),
      createdAt: Number.isFinite(created) ? created : undefined,
      fdvUsd: num(a.fdv_usd),
      marketCapUsd: num(a.market_cap_usd),
      reserveUsd: num(a.reserve_in_usd),
      volume: { m5: num(a.volume_usd?.m5), h1: num(a.volume_usd?.h1), h6: num(a.volume_usd?.h6), h24: num(a.volume_usd?.h24) },
      priceChange: { m5: num(a.price_change_percentage?.m5), h1: num(a.price_change_percentage?.h1), h6: num(a.price_change_percentage?.h6), h24: num(a.price_change_percentage?.h24) },
      txns: { m5: tx("m5"), h1: tx("h1"), h6: tx("h6"), h24: tx("h24") },
    });
  }
  return out;
}

/** Converts a GeckoTerminal pool into the DexPair shape so scoring and security code can treat it like a DexScreener pair. */
export function geckoPoolToPair(p: GeckoPool): DexPair {
  const withoutBuyers = (x?: { buys: number; sells: number }) => (x ? { buys: x.buys, sells: x.sells } : undefined);
  return {
    chainId: p.chainId,
    dexId: p.dexId,
    pairAddress: p.poolAddress,
    baseToken: { address: p.baseToken.address, name: p.baseToken.name, symbol: p.baseToken.symbol },
    quoteToken: { address: "", name: p.quoteSymbol ?? "", symbol: p.quoteSymbol ?? "" },
    priceUsd: p.priceUsd,
    txns: { m5: withoutBuyers(p.txns.m5), h1: withoutBuyers(p.txns.h1), h6: withoutBuyers(p.txns.h6), h24: withoutBuyers(p.txns.h24) },
    volume: p.volume,
    priceChange: p.priceChange,
    liquidity: { usd: p.reserveUsd },
    fdv: p.fdvUsd,
    marketCap: p.marketCapUsd ?? p.fdvUsd,
    pairCreatedAt: p.createdAt,
    info: p.baseToken.imageUrl ? { imageUrl: p.baseToken.imageUrl } : undefined,
  };
}

export class GeckoTerminalClient {
  private readonly baseUrl: string;
  private readonly cache: TtlCache<GeckoPool[]>;
  private readonly bucket: TokenBucket;
  private readonly http: HttpOptions;
  private readonly now: Clock;
  /** last successful answer per chain: served when a refresh is rate limited (stale-if-error) */
  private readonly lastGood = new Map<string, { at: number; pools: GeckoPool[] }>();

  constructor(opts: GeckoClientOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.baseUrl = opts.baseUrl ?? GECKO_BASE;
    this.cache = new TtlCache<GeckoPool[]>(opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, opts.now);
    // small burst, then 20/min: leaves headroom under the ~30/min free-tier limit (other tools may share the same IP)
    this.bucket = new TokenBucket({ capacity: 3, refillPerMinute: 20, now: opts.now, sleep: opts.sleep as Sleeper | undefined });
    this.http = { fetchImpl: opts.fetchImpl, sleep: opts.sleep, timeoutMs: opts.timeoutMs ?? 8_000, retries: opts.retries ?? 1, baseDelayMs: opts.baseDelayMs ?? 600 };
  }

  /** Newest pools on one chain (DexScreener chainId), newest first. Empty for chains GeckoTerminal does not map. */
  async newPools(chainId: string): Promise<GeckoPool[]> {
    const slug = GECKO_NETWORKS[chainId];
    if (!slug) return [];
    const url = `${this.baseUrl}/networks/${slug}/new_pools?include=base_token&page=1`;
    try {
      const pools = await this.cache.wrap(url, async () => {
        await this.bucket.acquire();
        return parseNewPools(chainId, slug, await fetchJson<Json>(url, this.http));
      });
      this.lastGood.set(chainId, { at: this.now(), pools });
      return pools;
    } catch (e) {
      // 429 / network blip: new pools are only interesting for minutes, so a 3-minute-old answer is still useful
      const prev = this.lastGood.get(chainId);
      if (prev && this.now() - prev.at < STALE_IF_ERROR_MS) return prev.pools;
      throw e;
    }
  }
}
