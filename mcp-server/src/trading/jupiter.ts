/**
 * Jupiter swap API client.
 *
 * Hosts are tried in order with failover:
 *   1. https://quote-api.jup.ag/v6          (the documented v6 endpoint)
 *   2. https://lite-api.jup.ag/swap/v1      (same request/response shape; the host that
 *                                            answers when v6 is unreachable)
 * Override with the JUPITER_API_URL env var (single base, no failover). A host that fails
 * with a network/5xx/404 error is skipped for 5 minutes. Client errors (400/422: no route,
 * bad amount) are real answers and are never retried on another host.
 */
import { fetchJson, HttpError, type HttpOptions } from "../http.js";
import { TokenBucket, type Clock, type Sleeper } from "../limiter.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const JUPITER_BASES = ["https://quote-api.jup.ag/v6", "https://lite-api.jup.ag/swap/v1"] as const;
const DOWN_MS = 5 * 60_000;

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct?: string;
  routePlan?: unknown[];
  contextSlot?: number;
  [k: string]: unknown;
}

export interface JupiterSwap {
  /** Base64 unsigned (versioned) transaction. */
  swapTransaction: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
}

export class JupiterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JupiterError";
  }
}

export interface JupiterOptions extends HttpOptions {
  bases?: readonly string[];
  now?: Clock;
  sleep?: Sleeper;
}

export class JupiterClient {
  private readonly bases: readonly string[];
  private readonly http: HttpOptions;
  private readonly now: Clock;
  private readonly bucket: TokenBucket;
  private readonly downUntil = new Map<string, number>();
  /** Host that served the most recent successful call. */
  lastBase?: string;

  constructor(opts: JupiterOptions = {}) {
    this.bases = (opts.bases ?? JUPITER_BASES).map((b) => b.replace(/\/+$/, ""));
    this.now = opts.now ?? Date.now;
    this.http = { fetchImpl: opts.fetchImpl, sleep: opts.sleep, timeoutMs: opts.timeoutMs ?? 8_000, retries: opts.retries ?? 1, baseDelayMs: opts.baseDelayMs ?? 300 };
    this.bucket = new TokenBucket({ capacity: 5, refillPerMinute: 40, now: opts.now, sleep: opts.sleep });
  }

  async quote(p: { inputMint: string; outputMint: string; amount: bigint | number | string; slippageBps: number }): Promise<JupiterQuote> {
    const qs = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: String(p.amount),
      slippageBps: String(Math.round(p.slippageBps)),
      restrictIntermediateTokens: "true",
    });
    const q = await this.request<JupiterQuote>(`/quote?${qs}`);
    if (!q || typeof q.outAmount !== "string" || !/^\d+$/.test(q.outAmount) || q.outAmount === "0") {
      throw new JupiterError("Jupiter returned no usable route (empty outAmount)");
    }
    return q;
  }

  /** Builds an unsigned swap transaction for `userPublicKey` from a quote. */
  async swap(p: { quoteResponse: JupiterQuote; userPublicKey: string; prioritizationFeeLamports?: number }): Promise<JupiterSwap> {
    const s = await this.request<JupiterSwap>("/swap", {
      method: "POST",
      body: {
        quoteResponse: p.quoteResponse,
        userPublicKey: p.userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        ...(p.prioritizationFeeLamports ? { prioritizationFeeLamports: p.prioritizationFeeLamports } : {}),
      },
    });
    if (!s || typeof s.swapTransaction !== "string" || !s.swapTransaction) throw new JupiterError("Jupiter returned no swap transaction");
    return s;
  }

  private async request<T>(path: string, init: Pick<HttpOptions, "method" | "body"> = {}): Promise<T> {
    const t = this.now();
    const live = this.bases.filter((b) => (this.downUntil.get(b) ?? 0) <= t);
    const order = live.length ? live : [...this.bases]; // everything marked down: try them all anyway
    const failures: string[] = [];
    for (const base of order) {
      await this.bucket.acquire();
      try {
        const out = await fetchJson<T>(`${base}${path}`, { ...this.http, ...init });
        this.lastBase = base;
        this.downUntil.delete(base);
        return out;
      } catch (e) {
        if (e instanceof HttpError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 404 && e.status !== 429 && e.status !== 403) {
          throw new JupiterError(`Jupiter rejected the request (HTTP ${e.status}): no route or invalid parameters`, e.status);
        }
        this.downUntil.set(base, this.now() + DOWN_MS);
        failures.push(`${new URL(base).host}: ${e instanceof HttpError ? (e.status ? `HTTP ${e.status}` : e.message) : e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new JupiterError(`Jupiter unavailable (${failures.join("; ")})`);
  }
}
