/**
 * Small, dependency-free infrastructure primitives:
 *  - TokenBucket: async pacing queue that enforces a per-minute request budget
 *  - TtlCache: in-memory cache with per-entry expiry and in-flight de-duplication
 *
 * Time and sleeping are injectable so behaviour is unit-testable without real delays.
 */

export type Clock = () => number;
export type Sleeper = (ms: number) => Promise<void>;

export const realSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TokenBucketOptions {
  /** Max tokens that can be spent instantly (burst size). */
  capacity: number;
  /** Sustained refill rate, in requests per minute. */
  refillPerMinute: number;
  now?: Clock;
  sleep?: Sleeper;
}

/**
 * Token bucket with a FIFO pacing queue. `acquire()` resolves when a token is available.
 *
 * Over any 60 s window at most `capacity + refillPerMinute` requests pass, so choose
 * `capacity + refillPerMinute <= hardLimit` to stay under a provider's limit.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private tail: Promise<void> = Promise.resolve();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: Clock;
  private readonly sleep: Sleeper;

  constructor(opts: TokenBucketOptions) {
    if (opts.capacity < 1) throw new Error("capacity must be >= 1");
    if (opts.refillPerMinute <= 0) throw new Error("refillPerMinute must be > 0");
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerMinute / 60_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.tokens = opts.capacity;
    this.lastRefill = this.now();
  }

  /** Waits (in FIFO order) until one token is available, then consumes it. */
  acquire(): Promise<void> {
    const run = this.tail.then(() => this.take());
    this.tail = run.catch(() => undefined);
    return run;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefill);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = t;
  }

  private async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs));
      await this.sleep(waitMs);
    }
  }
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<V = unknown> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: Clock = Date.now,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.store.size >= this.maxEntries) this.prune();
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  /**
   * Returns the cached value, or runs `loader` once even when called concurrently
   * for the same key. Failed loads are not cached.
   */
  async wrap(key: string, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = loader()
      .then((v) => {
        this.set(key, v);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.store) if (e.expiresAt <= t) this.store.delete(k);
    // Still full: drop oldest insertions.
    while (this.store.size >= this.maxEntries) {
      const first = this.store.keys().next();
      if (first.done) break;
      this.store.delete(first.value);
    }
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
