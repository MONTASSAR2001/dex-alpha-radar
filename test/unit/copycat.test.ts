import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DexScreenerClient } from "../../mcp-server/src/dexscreener.js";
import { SecurityAuditor } from "../../mcp-server/src/security.js";
import { flagDuplicateSymbols, scanOpportunities } from "../../mcp-server/src/tools/index.js";
import { fakeTime, makePair, mockFetch, NOW } from "../helpers.js";

describe("copycat ticker detection", () => {
  it("flags different tokens sharing a ticker inside one result set, and only those", () => {
    const row = (symbol: string, tokenAddress: string, chain = "solana") => ({ symbol, tokenAddress, chain, warnings: [] as string[] });
    const out = flagDuplicateSymbols([row("GTA", "AAA"), row("gta", "BBB"), row("REX", "CCC"), row("REX", "CCC"), row("GTA", "aaa", "base")]);
    assert.ok(out[0]!.warnings[0]!.includes("shared by 3 different tokens"));
    assert.equal(out[1]!.warnings.length, 1);
    assert.deepEqual(out[2]!.warnings, [], "the same token listed twice is not a copycat");
    assert.deepEqual(out[3]!.warnings, []);
  });

  it("does not mutate its input", () => {
    const rows = [{ symbol: "A", tokenAddress: "1", chain: "solana", warnings: [] as string[] }, { symbol: "A", tokenAddress: "2", chain: "solana", warnings: [] as string[] }];
    flagDuplicateSymbols(rows);
    assert.deepEqual(rows[0]!.warnings, []);
  });

  it("is applied to scan results", async () => {
    const clock = fakeTime(NOW);
    const A = ("DupAaaa" + "1".repeat(40)).slice(0, 43);
    const B = ("DupBbbb" + "1".repeat(40)).slice(0, 43);
    const mk = (a: string) => makePair({ addr: a, baseToken: { address: a, name: "Same", symbol: "SAME" } });
    const { fn } = mockFetch((url) => {
      if (url.includes("/token-boosts/latest")) return { body: [A, B].map((t) => ({ chainId: "solana", tokenAddress: t })) };
      if (url.includes("/token-boosts/top") || url.includes("/community-takeovers") || url.includes("/token-profiles")) return { body: [] };
      if (url.includes("/tokens/v1/solana/")) return { body: [mk(A), mk(B)] };
      if (url.includes("rugcheck.xyz")) return { body: { score_normalised: 2, risks: [], mintAuthority: null, freezeAuthority: null } };
      return undefined;
    });
    const o = { fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 5, retries: 0 };
    const r = await scanOpportunities({ dex: new DexScreenerClient(o), security: new SecurityAuditor(o), now: clock.now }, { chain: "solana" });
    assert.equal(r.results.length, 2);
    for (const x of r.results) assert.ok(x.warnings.some((w) => /possible copycat/.test(w)), JSON.stringify(x.warnings));
  });
});
