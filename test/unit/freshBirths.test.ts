import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DexScreenerClient } from "../../mcp-server/src/dexscreener.js";
import { GeckoTerminalClient, parseNewPools } from "../../mcp-server/src/geckoterminal.js";
import { SecurityAuditor } from "../../mcp-server/src/security.js";
import { computeBirthVelocity, detectFreshBirths, explorerLink, tradeLink, type ToolDeps } from "../../mcp-server/src/tools.js";
import { fakeTime, makePair, mockFetch, NOW } from "../helpers.js";

const MIN0 = "Min0Mint111111111111111111111111111111111111"; // 40 s old, only on GeckoTerminal (DexScreener has no pair yet)
const YOUNG = "YoungMint11111111111111111111111111111111111"; // 7 min old on DexScreener
const OLD = "OldMint1111111111111111111111111111111111111"; // 3 h old: outside the window
const RUG = "RugBirth111111111111111111111111111111111111"; // 5 min old, mint authority active
const EVM = "0x2222222222222222222222222222222222222222";

const geckoBody = (slug: string) =>
  slug === "solana"
    ? {
        data: [
          {
            id: "solana_poolMin0",
            attributes: {
              address: "poolMin0",
              name: "MIN0 / SOL",
              pool_created_at: new Date(NOW - 40_000).toISOString(),
              base_token_price_usd: "0.0000123",
              fdv_usd: "12300",
              reserve_in_usd: "4500",
              volume_usd: { m5: "3000", h1: "3000", h24: "3000" },
              price_change_percentage: { m5: "45", h1: "45", h24: "45" },
              transactions: { m5: { buys: 30, sells: 5, buyers: 20, sellers: 4 }, h1: { buys: 30, sells: 5 }, h24: { buys: 30, sells: 5 } },
            },
            relationships: { base_token: { data: { id: `solana_${MIN0}` } }, dex: { data: { id: "pump-fun" } } },
          },
        ],
        included: [{ id: `solana_${MIN0}`, type: "token", attributes: { address: MIN0, name: "Minute Zero", symbol: "MIN0", image_url: "https://img.example/min0.png" } }],
      }
    : slug === "base"
      ? {
          data: [
            {
              id: "base_poolBase",
              attributes: { address: "0xpoolbase", name: "BASEB / WETH 1%", pool_created_at: new Date(NOW - 5 * 60_000).toISOString(), base_token_price_usd: "0.5", reserve_in_usd: "20000", volume_usd: { m5: "1000" }, price_change_percentage: { m5: "3" }, transactions: { m5: { buys: 8, sells: 8 } } },
              relationships: { base_token: { data: { id: `base_${EVM}` } }, dex: { data: { id: "uniswap-v3-base" } } },
            },
          ],
          included: [{ id: `base_${EVM}`, type: "token", attributes: { address: EVM, name: "Base Born", symbol: "BASEB", image_url: "https://assets.geckoterminal.com/missing.png" } }],
        }
      : { data: [], included: [] };

function setup(opts: { withGecko?: boolean } = {}) {
  const clock = fakeTime(NOW);
  const { fn, calls } = mockFetch((url) => {
    if (url.includes("geckoterminal.com")) return { body: geckoBody(url.split("/networks/")[1]!.split("/")[0]!) };
    if (url.includes("/token-profiles")) return { body: [{ chainId: "solana", tokenAddress: YOUNG }, { chainId: "solana", tokenAddress: OLD }] };
    if (url.includes("/token-boosts") || url.includes("/community-takeovers")) return { body: [] };
    if (url.includes("/tokens/v1/solana/")) {
      const wanted = url.split("/tokens/v1/solana/")[1]!.split(",");
      const all = {
        [YOUNG]: makePair({ addr: YOUNG, baseToken: { address: YOUNG, name: "Young", symbol: "YOUNG" }, pairCreatedAt: NOW - 7 * 60_000, info: { imageUrl: "https://img.example/young.png", socials: [{ type: "twitter", url: "https://x.com/young" }, { type: "telegram", url: "https://t.me/young" }], websites: [{ url: "https://young.xyz" }] } }),
        [OLD]: makePair({ addr: OLD, baseToken: { address: OLD, name: "Old", symbol: "OLD" }, pairCreatedAt: NOW - 3 * 3_600_000 }),
        [RUG]: makePair({ addr: RUG, baseToken: { address: RUG, name: "Rug", symbol: "RUGB" }, pairCreatedAt: NOW - 5 * 60_000 }),
      } as Record<string, ReturnType<typeof makePair>>;
      return { body: wanted.map((a) => all[a]).filter(Boolean) };
    }
    if (url.includes("/tokens/v1/base/")) return { body: [] }; // DexScreener has not indexed it yet
    if (url.includes("/latest/dex/search")) {
      const q = decodeURIComponent(url.split("q=")[1]!);
      if (q === "pumpswap") return { body: { pairs: [makePair({ addr: RUG, baseToken: { address: RUG, name: "Rug", symbol: "RUGB" }, pairCreatedAt: NOW - 5 * 60_000 })] } };
      return { body: { pairs: [] } };
    }
    if (url.includes("rugcheck.xyz")) {
      if (url.includes(RUG)) return { body: { score_normalised: 85, risks: [{ name: "Mint Authority still enabled", level: "danger" }], mintAuthority: "Auth", freezeAuthority: null } };
      return { body: { score_normalised: 2, risks: [], mintAuthority: null, freezeAuthority: null, topHolders: [{ pct: 5 }] } };
    }
    if (url.includes("gopluslabs.io")) return { body: { code: 1, result: { [EVM]: { is_honeypot: "0", buy_tax: "0", sell_tax: "0", cannot_sell_all: "0", owner_change_balance: "0", is_open_source: "1" } } } };
    return undefined;
  });
  const o = { fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 5, retries: 1 };
  const deps: ToolDeps = { dex: new DexScreenerClient(o), security: new SecurityAuditor(o), now: clock.now };
  if (opts.withGecko !== false) deps.gecko = new GeckoTerminalClient(o);
  return { deps, calls };
}

describe("parseNewPools", () => {
  it("normalizes a GeckoTerminal pool and drops the placeholder image", () => {
    const pools = parseNewPools("base", "base", geckoBody("base"));
    assert.equal(pools.length, 1);
    assert.equal(pools[0]!.baseToken.address, EVM);
    assert.equal(pools[0]!.baseToken.symbol, "BASEB");
    assert.equal(pools[0]!.baseToken.imageUrl, undefined, "missing.png is not a real logo");
    assert.equal(pools[0]!.dexId, "uniswap");
    assert.equal(pools[0]!.reserveUsd, 20000);
  });
});

describe("detect_fresh_births", () => {
  it("returns only pairs inside the window, freshest first, with GeckoTerminal-only pools", async () => {
    const { deps } = setup();
    const r = await detectFreshBirths(deps, { maxAgeMinutes: 20, includeRisky: true });
    assert.deepEqual(r.results.map((x) => x.symbol), ["MIN0", "RUGB", "BASEB", "YOUNG"].filter((s) => r.results.some((x) => x.symbol === s)).sort((a, b) => r.results.findIndex((x) => x.symbol === a) - r.results.findIndex((x) => x.symbol === b)));
    const ages = r.results.map((x) => x.ageSeconds);
    assert.deepEqual([...ages].sort((a, b) => a - b), ages, "ageSeconds ascending");
    assert.ok(!r.results.some((x) => x.symbol === "OLD"), "3h old pair is outside the 20m window");
    const min0 = r.results[0]!;
    assert.equal(min0.symbol, "MIN0");
    assert.equal(min0.ageSeconds, 40);
    assert.equal(min0.isMinuteZero, true);
    assert.equal(min0.source, "geckoterminal");
    assert.equal(min0.imageUrl, "https://img.example/min0.png");
    assert.equal(min0.priceUsd, "0.0000123");
    assert.equal(min0.liquidityUsd, 4500);
    assert.equal(min0.tradeLabel, "Pump.fun");
    assert.equal(min0.tradeUrl, `https://pump.fun/coin/${MIN0}`);
    assert.equal(min0.explorerUrl, `https://solscan.io/token/${MIN0}`);
    assert.ok(min0.dexscreenerUrl.startsWith("https://dexscreener.com/solana/"));
  });

  it("extracts socials, exact age and images for DexScreener pairs", async () => {
    const { deps } = setup();
    const r = await detectFreshBirths(deps, { maxAgeMinutes: 20 });
    const young = r.results.find((x) => x.symbol === "YOUNG")!;
    assert.equal(young.ageMinutes, 7);
    assert.equal(young.socials.twitter, "https://x.com/young");
    assert.equal(young.socials.telegram, "https://t.me/young");
    assert.deepEqual(young.socials.websites, ["https://young.xyz"]);
    assert.equal(young.imageUrl, "https://img.example/young.png");
    assert.equal(young.security.status, "SAFE");
    assert.equal(young.pairCreatedAt, NOW - 7 * 60_000);
  });

  it("hides DANGER tokens by default and flags them when includeRisky", async () => {
    const { deps } = setup();
    const safe = await detectFreshBirths(deps, {});
    assert.ok(!safe.results.some((x) => x.symbol === "RUGB"));
    const risky = await detectFreshBirths(deps, { includeRisky: true });
    const rug = risky.results.find((x) => x.symbol === "RUGB")!;
    assert.equal(rug.rejected, true);
    assert.equal(rug.security.status, "DANGER");
  });

  it("respects maxAgeMinutes, minLiquidityUsd and chain", async () => {
    const { deps } = setup();
    const tight = await detectFreshBirths(deps, { maxAgeMinutes: 1, includeRisky: true });
    assert.deepEqual(tight.results.map((x) => x.symbol), ["MIN0"]);
    const liq = await detectFreshBirths(deps, { minLiquidityUsd: 10_000, includeRisky: true });
    assert.ok(!liq.results.some((x) => x.symbol === "MIN0"), "MIN0 has only $4.5k liquidity");
    const base = await detectFreshBirths(deps, { chain: "base" });
    assert.deepEqual(base.results.map((x) => x.symbol), ["BASEB"]);
    assert.equal(base.results[0]!.tradeLabel, "Uniswap");
    assert.equal(base.results[0]!.explorerUrl, `https://basescan.org/token/${EVM}`);
  });

  it("works without a GeckoTerminal client (DexScreener sources only) and says so", async () => {
    const { deps } = setup({ withGecko: false });
    const r = await detectFreshBirths(deps, {});
    assert.ok(!r.results.some((x) => x.symbol === "MIN0"));
    assert.ok(r.warnings.some((w) => /GeckoTerminal client not configured/.test(w)));
    assert.ok(r.results.some((x) => x.symbol === "YOUNG"));
  });

  it("de-duplicates a token that appears in several sources", async () => {
    const { deps } = setup();
    const r = await detectFreshBirths(deps, { includeRisky: true });
    const keys = r.results.map((x) => `${x.chain}:${x.tokenAddress}`);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe("early birth velocity + links", () => {
  it("rewards buy dominance, volume vs liquidity and price surge; penalizes DANGER", () => {
    const hot = makePair({ txns: { m5: { buys: 40, sells: 5 } }, volume: { m5: 5_000 }, priceChange: { m5: 40 }, liquidity: { usd: 8_000 } });
    const cold = makePair({ txns: { m5: { buys: 3, sells: 12 } }, volume: { m5: 100 }, priceChange: { m5: -10 }, liquidity: { usd: 8_000 } });
    const a = computeBirthVelocity(hot, 2, 20, undefined);
    const b = computeBirthVelocity(cold, 2, 20, undefined);
    assert.ok(a.velocityScore > b.velocityScore + 30);
    const danger = computeBirthVelocity(hot, 2, 20, { status: "DANGER", chainId: "solana", address: "x", source: "rugcheck", verdict: "bad", flags: [] });
    assert.equal(danger.rejected, true);
    assert.ok(danger.velocityScore < a.velocityScore);
    assert.ok(a.warnings.some((w) => /Minute-0/.test(w)));
  });

  it("builds trade and explorer links per chain/DEX", () => {
    assert.equal(tradeLink(makePair({ dexId: "pumpfun" }))?.label, "Pump.fun");
    assert.equal(tradeLink(makePair({ dexId: "raydium" }))?.label, "Raydium");
    assert.equal(tradeLink(makePair({ dexId: "meteora" }))?.label, "Jupiter");
    assert.equal(tradeLink(makePair({ chainId: "bsc", dexId: "pancakeswap" }))?.label, "PancakeSwap");
    assert.equal(explorerLink("ethereum", "0xabc")?.url, "https://etherscan.io/token/0xabc");
    assert.equal(explorerLink("unknownchain", "x"), undefined);
  });
});

describe("GeckoTerminalClient resilience", () => {
  it("serves the last good pools when a refresh is rate limited", async () => {
    const clock = fakeTime(NOW);
    let fail = false;
    const { fn } = mockFetch(() => (fail ? { status: 429, body: {} } : { body: geckoBody("solana") }));
    const g = new GeckoTerminalClient({ fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 1, retries: 0, cacheTtlMs: 1000 });
    assert.equal((await g.newPools("solana")).length, 1);
    fail = true;
    clock.advance(5_000); // cache expired, upstream now 429
    assert.equal((await g.newPools("solana")).length, 1, "stale-if-error");
    clock.advance(10 * 60_000); // too old to be useful
    await assert.rejects(() => g.newPools("solana"));
    assert.deepEqual(await g.newPools("dogecoin"), [], "unmapped chains return nothing");
  });
});
