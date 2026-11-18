import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DexScreenerClient } from "../../mcp-server/src/dexscreener.js";
import { createServer } from "../../mcp-server/src/index.js";
import { SecurityAuditor } from "../../mcp-server/src/security.js";
import { auditTokenSecurity, compareWatchlist, detectMomentumBreakouts, inspectToken, scanOpportunities, type ToolDeps } from "../../mcp-server/src/tools/index.js";
import { fakeTime, makePair, mockFetch, NOW } from "../helpers.js";

const GOOD = "GoodMint1111111111111111111111111111111111";
const RUG = "RugMint11111111111111111111111111111111111";
const FRESH = "NewMint11111111111111111111111111111111111";
const EVM_TOKEN = "0x1111111111111111111111111111111111111111";

const pairs = {
  [GOOD]: makePair({ addr: GOOD, baseToken: { address: GOOD, name: "Good", symbol: "GOOD" } }),
  [RUG]: makePair({ addr: RUG, baseToken: { address: RUG, name: "Rug", symbol: "RUG" }, txns: { m5: { buys: 50, sells: 2 }, h1: { buys: 500, sells: 20 } } }),
  [FRESH]: makePair({ addr: FRESH, baseToken: { address: FRESH, name: "Fresh", symbol: "FRESH" }, pairCreatedAt: NOW - 500 * 3_600_000 }),
};

function setup(overrides: { failRugcheck?: boolean } = {}) {
  const clock = fakeTime(NOW);
  const { fn, calls } = mockFetch((url) => {
    if (url.includes("/token-boosts/latest")) return { body: [{ chainId: "solana", tokenAddress: GOOD, totalAmount: 50 }, { chainId: "solana", tokenAddress: RUG, totalAmount: 10 }] };
    if (url.includes("/token-boosts/top")) return { body: [{ chainId: "solana", tokenAddress: GOOD, totalAmount: 100 }] };
    if (url.includes("/token-profiles")) return { body: [{ chainId: "solana", tokenAddress: FRESH }, { chainId: "base", tokenAddress: EVM_TOKEN }] };
    if (url.includes("/community-takeovers")) return { body: [{ chainId: "solana", tokenAddress: GOOD }] };
    if (url.includes("/tokens/v1/solana/")) {
      const wanted = url.split("/tokens/v1/solana/")[1]!.split(",");
      return { body: wanted.map((a) => pairs[a as keyof typeof pairs]).filter(Boolean) };
    }
    if (url.includes("/tokens/v1/base/")) {
      return { body: [makePair({ chainId: "base", addr: EVM_TOKEN, baseToken: { address: EVM_TOKEN, name: "Base Coin", symbol: "BASEC" } })] };
    }
    if (url.includes("/latest/dex/search")) {
      const q = decodeURIComponent(url.split("q=")[1]!);
      if (q.toLowerCase() === "good" || q === GOOD) return { body: { pairs: [pairs[GOOD], { ...pairs[GOOD], pairAddress: "second", liquidity: { usd: 1_000 } }, makePair({ addr: "Copycat111111111111111111111111111111111", baseToken: { address: "Copycat111111111111111111111111111111111", name: "Good", symbol: "GOOD" }, liquidity: { usd: 2_000 } })] } };
      if (q === EVM_TOKEN) return { body: { pairs: [makePair({ chainId: "base", addr: EVM_TOKEN, baseToken: { address: EVM_TOKEN, name: "Base Coin", symbol: "BASEC" } })] } };
      return { body: { pairs: [] } };
    }
    if (url.includes("rugcheck.xyz")) {
      if (overrides.failRugcheck) return { status: 500 };
      if (url.includes(RUG)) return { body: { score_normalised: 80, risks: [{ name: "Mint Authority still enabled", level: "danger" }], mintAuthority: "Auth", freezeAuthority: null } };
      return { body: { score_normalised: 3, risks: [], mintAuthority: null, freezeAuthority: null, topHolders: [{ pct: 12 }] } };
    }
    if (url.includes("gopluslabs.io")) return { body: { code: 1, result: { [EVM_TOKEN]: { is_honeypot: "0", buy_tax: "0.01", sell_tax: "0.01", cannot_sell_all: "0", owner_change_balance: "0", is_open_source: "1" } } } };
    return undefined;
  });
  const opts = { fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 5, retries: 1 };
  const deps: ToolDeps = { dex: new DexScreenerClient(opts), security: new SecurityAuditor(opts), now: clock.now };
  return { deps, calls };
}

describe("scan_opportunities", () => {
  it("ranks audited candidates and hides DANGER by default", async () => {
    const { deps } = setup();
    const r = await scanOpportunities(deps, { chain: "solana", minLiquidityUsd: 10_000 });
    const symbols = r.results.map((x) => x.symbol);
    assert.deepEqual(symbols, ["GOOD"], "RUG is hidden (DANGER), FRESH is older than 72h");
    const good = r.results[0]!;
    assert.equal(good.rank, 1);
    assert.equal(good.security.status, "SAFE");
    assert.equal(good.catalysts.boosted, true);
    assert.equal(good.catalysts.cto, true);
    assert.equal(good.priceUsd, "0.00001234");
    assert.ok(good.url.startsWith("https://dexscreener.com/"));
    assert.equal(r.stats.candidates, 3);
    assert.match(r.disclaimer, /not financial advice/i);
  });

  it("includeRisky shows rejected tokens, ranked last, with REJECTED reasons", async () => {
    const { deps } = setup();
    const r = await scanOpportunities(deps, { chain: "solana", includeRisky: true });
    assert.deepEqual(r.results.map((x) => x.symbol), ["GOOD", "RUG"]);
    const rug = r.results[1]!;
    assert.equal(rug.rejected, true);
    assert.equal(rug.security.status, "DANGER");
    assert.ok(rug.reasons.some((x) => x.startsWith("REJECTED")));
  });

  it("applies liquidity and age filters", async () => {
    const { deps } = setup();
    assert.equal((await scanOpportunities(deps, { chain: "solana", minLiquidityUsd: 500_000 })).results.length, 0);
    const old = await scanOpportunities(deps, { chain: "solana", maxAgeHours: 1000, includeRisky: true });
    assert.ok(old.results.some((x) => x.symbol === "FRESH"));
  });

  it("filters by chain and audits EVM tokens through GoPlus", async () => {
    const { deps, calls } = setup();
    const r = await scanOpportunities(deps, { chain: "base" });
    assert.deepEqual(r.results.map((x) => x.symbol), ["BASEC"]);
    assert.equal(r.results[0]!.security.status, "SAFE");
    assert.ok(calls.some((u) => u.includes("/token_security/8453")));
  });

  it("batch-fetches pairs per chain (one call per chain for small lists)", async () => {
    const { deps, calls } = setup();
    await scanOpportunities(deps, { chain: "all" });
    assert.equal(calls.filter((u) => u.includes("/tokens/v1/")).length, 2);
  });

  it("fails closed when security data is unavailable: UNVERIFIED, no safety bonus, still shown", async () => {
    const { deps } = setup({ failRugcheck: true });
    const r = await scanOpportunities(deps, { chain: "solana" });
    assert.ok(r.results.length > 0);
    assert.ok(r.results.every((x) => x.security.status === "UNVERIFIED"));
    assert.ok(r.results.every((x) => x.scoreBreakdown.securityAdjustment === 0));
  });

  it("surfaces partial discovery failures as warnings, and errors if everything fails", async () => {
    const clock = fakeTime(NOW);
    const { fn } = mockFetch((u) => (u.includes("token-boosts/top") ? { status: 400 } : u.includes("/tokens/v1") ? { body: [] } : { body: [] }));
    const deps: ToolDeps = { dex: new DexScreenerClient({ fetchImpl: fn, now: clock.now, sleep: clock.sleep }), security: new SecurityAuditor({ fetchImpl: fn }), now: clock.now };
    const r = await scanOpportunities(deps, {});
    assert.equal(r.warnings.length, 1);
    const { fn: dead } = mockFetch(() => ({ status: 400 }));
    const deadDeps: ToolDeps = { dex: new DexScreenerClient({ fetchImpl: dead, now: clock.now, sleep: clock.sleep }), security: new SecurityAuditor({ fetchImpl: dead }) };
    await assert.rejects(scanOpportunities(deadDeps, {}), /All DexScreener discovery endpoints failed/);
  });
});

describe("inspect_token", () => {
  it("finds a token by symbol, picks the deepest token and warns about copycats", async () => {
    const { deps } = setup();
    const r = await inspectToken(deps, { query: "$good" });
    assert.equal(r.found, true);
    if (!r.found) return;
    assert.equal(r.token.tokenAddress, GOOD);
    assert.equal(r.token.security.status, "SAFE");
    assert.equal(r.pools.length, 2);
    assert.equal(r.otherMatches.length, 1);
    assert.match(r.warnings[0]!, /Copycat/);
    assert.equal(r.securityDetail.topHolderPct, 12, "inspect runs a deep audit");
  });

  it("looks up by contract address without symbol-collision warnings", async () => {
    const { deps } = setup();
    const r = await inspectToken(deps, { query: GOOD });
    assert.equal(r.found && r.token.tokenAddress, GOOD);
    assert.ok(r.found && r.otherMatches.length === 0 && r.warnings.length === 0);
  });

  it("reports not found cleanly", async () => {
    const { deps } = setup();
    const r = await inspectToken(deps, { query: "nonexistentcoin" });
    assert.equal(r.found, false);
    await assert.rejects(inspectToken(deps, { query: "  " }), /must not be empty/);
  });
});

describe("audit_token_security", () => {
  it("returns flags, authorities and verdict", async () => {
    const { deps } = setup();
    const r = await auditTokenSecurity(deps, { chain: "SOL", address: RUG });
    assert.equal(r.chain, "solana");
    assert.equal(r.status, "DANGER");
    assert.equal(r.mintAuthorityActive, true);
    assert.match(r.verdict, /mint authority ACTIVE/);
  });

  it("audits EVM contracts via GoPlus", async () => {
    const { deps } = setup();
    const r = await auditTokenSecurity(deps, { chain: "base", address: EVM_TOKEN });
    assert.equal(r.status, "SAFE");
    assert.equal(r.sellTax, 0.01);
  });
});

describe("detect_momentum_breakouts", () => {
  it("returns only tokens with 5m acceleration + buy dominance, with breakout metrics", async () => {
    const { deps } = setup();
    // GOOD: m5 20k*12/80k = 3x with 75% buys => qualifies. RUG is DANGER => hidden.
    const r = await detectMomentumBreakouts(deps, { chain: "solana" });
    assert.deepEqual(r.results.map((x) => x.symbol), ["GOOD"]);
    assert.equal(r.results[0]!.breakout.isBreakout, true);
    assert.equal(r.results[0]!.breakout.volumeAcceleration, 3);
    const risky = await detectMomentumBreakouts(deps, { chain: "solana", includeRisky: true });
    assert.ok(risky.results.some((x) => x.symbol === "RUG"));
  });

  it("returns near-misses when nothing qualifies", async () => {
    const { deps } = setup();
    const r = await detectMomentumBreakouts(deps, { chain: "solana", minAcceleration: 50 });
    assert.equal(r.results.length, 0);
    assert.ok(r.nearMisses.length > 0);
  });
});

describe("compare_watchlist", () => {
  it("compares tokens side by side ranked by Alpha Score, rejected last", async () => {
    const { deps, calls } = setup();
    const r = await compareWatchlist(deps, { tokens: [{ address: RUG }, { address: GOOD }, { address: "Missing11111111111111111111111111111111111" }] });
    assert.deepEqual(r.ranking.map((x) => x.symbol), ["GOOD", "RUG"]);
    assert.equal(r.ranking[1]!.rejected, true);
    assert.equal(r.notFound.length, 1);
    assert.equal(calls.filter((u) => u.includes("/tokens/v1/solana/")).length, 1, "one batched call for all Solana tokens");
  });

  it("resolves the chain of an EVM address automatically via search", async () => {
    const { deps, calls } = setup();
    const r = await compareWatchlist(deps, { tokens: [{ address: EVM_TOKEN }] });
    assert.equal(r.ranking[0]!.chain, "base");
    assert.ok(calls.some((u) => u.includes("/tokens/v1/base/")));
  });

  it("splits 70 Solana tokens across 30-address calls and validates input", async () => {
    const { deps, calls } = setup();
    const tokens = Array.from({ length: 60 }, (_, i) => ({ address: `Tok${String(i).padStart(40, "0")}`, chain: "solana" }));
    await compareWatchlist(deps, { tokens });
    assert.equal(calls.filter((u) => u.includes("/tokens/v1/solana/")).length, 2);
    await assert.rejects(compareWatchlist(deps, { tokens: [] }), /at least one/);
  });
});

describe("MCP server wiring", () => {
  it("registers exactly the ten documented tools", async () => {
    const { Client } = await import("../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
    const { InMemoryTransport } = await import("../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js");
    const { deps } = setup();
    const server = createServer(deps);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "analyze_trade_journal",
      "analyze_whale_forensics",
      "audit_token_security",
      "compare_watchlist",
      "detect_fresh_births",
      "detect_momentum_breakouts",
      "evaluate_narrative_pulse",
      "inspect_token",
      "scan_opportunities",
      "simulate_or_prepare_trade",
    ]);
    const res = await client.callTool({ name: "audit_token_security", arguments: { chain: "solana", address: GOOD } });
    const text = (res.content as { text: string }[])[0]!.text;
    assert.equal(JSON.parse(text).status, "SAFE");
    const bad = await client.callTool({ name: "inspect_token", arguments: { query: "" } });
    assert.equal(bad.isError, true);
    await client.close();
  });
});
