import type { DexPair } from "../mcp-server/src/types.js";

/** Deterministic clock: sleeping advances time instantly. */
export function fakeTime(start = 1_700_000_000_000) {
  const state = { t: start, slept: 0 };
  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => {
      state.t += ms;
      state.slept += ms;
    },
    advance: (ms: number) => {
      state.t += ms;
    },
  };
}

export interface MockReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw instead of responding (simulates network failure / timeout). */
  throws?: Error;
}

export type Handler = (url: string, call: number) => MockReply | undefined;

/** fetch mock that records calls. Unknown routes return 404. */
export function mockFetch(handler: Handler, onCall?: (url: string) => void) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    onCall?.(url);
    const reply = handler(url, calls.length) ?? { status: 404, body: { error: "not found" } };
    if (reply.throws) throw reply.throws;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof fetch;
  return { fn, calls };
}

export const NOW = 1_800_000_000_000;

/** Builds a realistic DexScreener pair; override anything. */
export function makePair(over: Partial<DexPair> & { addr?: string } = {}): DexPair {
  const addr = over.addr ?? "So11111111111111111111111111111111111111112";
  const { addr: _omit, ...rest } = over;
  return {
    chainId: "solana",
    dexId: "raydium",
    url: `https://dexscreener.com/solana/pair${addr.slice(0, 6)}`,
    pairAddress: `pair${addr.slice(0, 8)}`,
    baseToken: { address: addr, name: "Test Coin", symbol: "TEST" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL" },
    priceUsd: "0.00001234",
    txns: { m5: { buys: 30, sells: 10 }, h1: { buys: 300, sells: 150 }, h6: { buys: 900, sells: 700 }, h24: { buys: 2000, sells: 1800 } },
    volume: { m5: 20_000, h1: 80_000, h6: 200_000, h24: 400_000 },
    priceChange: { m5: 3, h1: 12, h6: 20, h24: 50 },
    liquidity: { usd: 80_000, base: 1, quote: 1 },
    fdv: 800_000,
    marketCap: 800_000,
    pairCreatedAt: NOW - 5 * 3_600_000,
    info: {
      websites: [{ label: "Website", url: "https://example.com" }],
      socials: [
        { type: "twitter", url: "https://x.com/test" },
        { type: "telegram", url: "https://t.me/test" },
      ],
    },
    boosts: { active: 0 },
    ...rest,
  };
}
