import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DexScreenerClient } from "../../mcp-server/src/dexscreener.js";
import type { DexPair } from "../../mcp-server/src/types.js";
import { probeNetwork } from "./live.js";

const skip = await probeNetwork();
const WSOL = "So11111111111111111111111111111111111111112";

function assertPairSchema(p: DexPair) {
  assert.equal(typeof p.chainId, "string");
  assert.equal(typeof p.pairAddress, "string");
  assert.equal(typeof p.baseToken.address, "string");
  assert.equal(typeof p.baseToken.symbol, "string");
  assert.ok(p.priceUsd === undefined || (typeof p.priceUsd === "string" && Number(p.priceUsd) >= 0), "priceUsd is an exact decimal string");
  assert.ok(p.liquidity?.usd === undefined || typeof p.liquidity.usd === "number");
  for (const w of ["m5", "h1", "h6", "h24"] as const) {
    const t = p.txns?.[w];
    if (t) assert.ok(typeof t.buys === "number" && typeof t.sells === "number", `txns.${w}`);
    const v = p.volume?.[w];
    if (v !== undefined) assert.equal(typeof v, "number", `volume.${w}`);
  }
}

describe("DexScreener live API", { skip }, () => {
  const dex = new DexScreenerClient();

  it("token-boosts/latest and /top return token signals", async () => {
    for (const list of [await dex.boostsLatest(), await dex.boostsTop()]) {
      assert.ok(list.length > 0);
      for (const s of list.slice(0, 5)) {
        assert.equal(typeof s.chainId, "string");
        assert.equal(typeof s.tokenAddress, "string");
        assert.ok(s.totalAmount === undefined || typeof s.totalAmount === "number");
      }
    }
  });

  it("token-profiles/latest returns profiles", async () => {
    const list = await dex.profilesLatest();
    assert.ok(list.length > 0);
    assert.equal(typeof list[0]!.tokenAddress, "string");
  });

  it("community-takeovers/latest returns an array of CTO entries", async () => {
    const list = await dex.ctoLatest();
    assert.ok(Array.isArray(list));
    for (const s of list.slice(0, 3)) assert.equal(typeof s.tokenAddress, "string");
  });

  it("search finds SOL and USDC pairs with the full metric schema", async () => {
    for (const q of ["SOL", "USDC"]) {
      const pairs = await dex.search(q);
      assert.ok(pairs.length > 0, q);
      pairs.slice(0, 10).forEach(assertPairSchema);
    }
  });

  it("tokens/v1 batch lookup returns pairs for wrapped SOL", async () => {
    const pairs = await dex.getTokenPairs("solana", [WSOL]);
    assert.ok(pairs.length > 0);
    pairs.slice(0, 10).forEach(assertPairSchema);
    assert.ok(pairs.some((p) => p.baseToken.address === WSOL));
  });

  it("tokens/v1 batch lookup works with mixed boosted tokens in one call", async () => {
    const boosted = (await dex.boostsLatest()).filter((b) => b.chainId === "solana").slice(0, 5).map((b) => b.tokenAddress);
    if (!boosted.length) return;
    const before = dex.requestCount;
    const pairs = await dex.getTokenPairs("solana", boosted);
    assert.equal(dex.requestCount - before, 1);
    pairs.forEach(assertPairSchema);
  });

  it("pairs/{chain}/{pairId} returns fresh stats for a known pair", async () => {
    const [first] = await dex.search("SOL USDC");
    assert.ok(first);
    const pair = await dex.getPair(first.chainId, first.pairAddress);
    assert.ok(pair);
    assertPairSchema(pair);
    assert.equal(pair.pairAddress.toLowerCase(), first.pairAddress.toLowerCase());
  });
});
