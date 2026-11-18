import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ENTRY_RULES, evaluateEntryRules, evaluateGuard, GUARD } from "../../mcp-server/src/trading/guard.js";
import { JupiterClient, JupiterError, JUPITER_BASES, WSOL_MINT } from "../../mcp-server/src/trading/jupiter.js";
import { TradeLedger, type Position } from "../../mcp-server/src/trading/ledger.js";
import { feesUsd, modelImpact, simulateBuyFill, simulateSellFill } from "../../mcp-server/src/trading/fills.js";
import { autoExecutionProblems, readLiveConfig } from "../../mcp-server/src/trading/guardrails.js";
import { fakeTime, makePair, mockFetch } from "../helpers.js";

const quoteBody = { inputMint: WSOL_MINT, inAmount: "1000000000", outputMint: "MINT", outAmount: "500000000", otherAmountThreshold: "490000000", slippageBps: 200, priceImpactPct: "0.01" };

describe("JupiterClient failover", () => {
  function client(handler: Parameters<typeof mockFetch>[0]) {
    const clock = fakeTime();
    const { fn, calls, bodies } = mockFetch(handler);
    return { j: new JupiterClient({ fetchImpl: fn, now: clock.now, sleep: clock.sleep, retries: 0 }), calls, bodies, clock };
  }
  const isV6 = (u: string) => u.startsWith("https://quote-api.jup.ag/v6");

  it("tries the v6 endpoint first and uses it when it works", async () => {
    const { j, calls } = client(() => ({ body: quoteBody }));
    await j.quote({ inputMint: WSOL_MINT, outputMint: "MINT", amount: 1_000_000_000n, slippageBps: 200 });
    assert.ok(calls[0]!.startsWith(`${JUPITER_BASES[0]}/quote?`));
    assert.match(calls[0]!, /inputMint=So111.*&outputMint=MINT&amount=1000000000&slippageBps=200/);
    assert.equal(j.lastBase, JUPITER_BASES[0]);
  });

  it("falls back to the lite API when v6 is unreachable, and skips the dead host afterwards", async () => {
    const { j, calls } = client((u) => (isV6(u) ? { throws: new TypeError("fetch failed") } : { body: quoteBody }));
    await j.quote({ inputMint: WSOL_MINT, outputMint: "MINT", amount: 1, slippageBps: 200 });
    assert.equal(j.lastBase, JUPITER_BASES[1]);
    assert.equal(calls.length, 2);
    await j.quote({ inputMint: WSOL_MINT, outputMint: "MINT", amount: 1, slippageBps: 200 });
    assert.equal(calls.length, 3, "the second call goes straight to the host that works");
    assert.ok(calls[2]!.startsWith(JUPITER_BASES[1]));
  });

  it("retries the dead host after the cool-down", async () => {
    let v6Up = false;
    const { j, calls, clock } = client((u) => (isV6(u) && !v6Up ? { throws: new TypeError("down") } : { body: quoteBody }));
    await j.quote({ inputMint: WSOL_MINT, outputMint: "MINT", amount: 1, slippageBps: 200 });
    v6Up = true;
    clock.advance(6 * 60_000);
    await j.quote({ inputMint: WSOL_MINT, outputMint: "MINT", amount: 1, slippageBps: 200 });
    assert.equal(j.lastBase, JUPITER_BASES[0]);
    assert.ok(isV6(calls.at(-1)!));
  });

  it("does not fail over on a real client error (no route / bad input)", async () => {
    const { j, calls } = client(() => ({ status: 400, body: { error: "COULD_NOT_FIND_ANY_ROUTE" } }));
    await assert.rejects(j.quote({ inputMint: WSOL_MINT, outputMint: "MINT", amount: 1, slippageBps: 200 }), (e) => e instanceof JupiterError && e.status === 400);
    assert.equal(calls.length, 1);
  });

  it("reports every host when all are down, and rejects empty routes", async () => {
    const down = client(() => ({ status: 503 }));
    await assert.rejects(down.j.quote({ inputMint: WSOL_MINT, outputMint: "MINT", amount: 1, slippageBps: 200 }), /Jupiter unavailable \(quote-api\.jup\.ag: HTTP 503; lite-api\.jup\.ag: HTTP 503\)/);
    const empty = client(() => ({ body: { ...quoteBody, outAmount: "0" } }));
    await assert.rejects(empty.j.quote({ inputMint: WSOL_MINT, outputMint: "MINT", amount: 1, slippageBps: 200 }), /no usable route/);
  });

  it("builds an unsigned swap with the documented POST body", async () => {
    const { j, calls, bodies } = client((u) => (u.endsWith("/swap") ? { body: { swapTransaction: "BASE64TX", lastValidBlockHeight: 123 } } : { body: quoteBody }));
    const q = await j.quote({ inputMint: WSOL_MINT, outputMint: "MINT", amount: 1, slippageBps: 200 });
    const s = await j.swap({ quoteResponse: q, userPublicKey: "WALLET", prioritizationFeeLamports: 500_000 });
    assert.equal(s.swapTransaction, "BASE64TX");
    assert.equal(calls[1], `${JUPITER_BASES[0]}/swap`);
    assert.deepEqual(bodies[1], { quoteResponse: q, userPublicKey: "WALLET", wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 500_000 });
    const { j: j2 } = client(() => ({ body: {} }));
    await assert.rejects(j2.swap({ quoteResponse: q, userPublicKey: "W" }), /no swap transaction/);
  });

  it("honours a custom base URL", async () => {
    const clock = fakeTime();
    const { fn, calls } = mockFetch(() => ({ body: quoteBody }));
    const j = new JupiterClient({ bases: ["https://custom.example/api/"], fetchImpl: fn, now: clock.now, sleep: clock.sleep, retries: 0 });
    await j.quote({ inputMint: WSOL_MINT, outputMint: "MINT", amount: 1, slippageBps: 50 });
    assert.ok(calls[0]!.startsWith("https://custom.example/api/quote?"));
  });
});

describe("entry rules", () => {
  const good = { ageMinutes: 3, security: "SAFE", alphaScore: 75, forensicsVerdict: "CLEAN_DISTRIBUTION", copycatRisk: "NONE" };

  it("passes only when every rule passes", () => {
    assert.equal(evaluateEntryRules(good).passed, true);
    assert.equal(evaluateEntryRules({ ...good, copycatRisk: "LOW" }).passed, true);
  });

  it("enforces each threshold at its exact boundary", () => {
    assert.equal(evaluateEntryRules({ ...good, ageMinutes: ENTRY_RULES.maxAgeMinutes }).passed, true);
    assert.equal(evaluateEntryRules({ ...good, ageMinutes: 5.1 }).passed, false);
    assert.equal(evaluateEntryRules({ ...good, alphaScore: 70 }).passed, true);
    assert.equal(evaluateEntryRules({ ...good, alphaScore: 69.9 }).passed, false);
    for (const security of ["WARNING", "DANGER", "UNVERIFIED"]) assert.equal(evaluateEntryRules({ ...good, security }).passed, false, security);
  });

  it("is fail-closed on unknown or unavailable data", () => {
    assert.equal(evaluateEntryRules({ ...good, ageMinutes: null }).passed, false);
    const f = evaluateEntryRules({ ...good, forensicsVerdict: "INSUFFICIENT_DATA" });
    assert.equal(f.passed, false);
    assert.match(f.failed[0]!, /fail-closed/);
    assert.equal(evaluateEntryRules({ ...good, forensicsVerdict: "BUNDLE_DETECTED" }).passed, false);
    for (const copycatRisk of ["MEDIUM", "HIGH", "UNKNOWN"]) assert.equal(evaluateEntryRules({ ...good, copycatRisk }).passed, false, copycatRisk);
  });

  it("lists every failed rule", () => {
    const r = evaluateEntryRules({ ageMinutes: 90, security: "WARNING", alphaScore: 40, forensicsVerdict: "BUNDLE_DETECTED", copycatRisk: "HIGH" });
    assert.equal(r.failed.length, 5);
  });
});

describe("Trailing Profit Guard", () => {
  const pos = (over: Partial<Pick<Position, "highWaterPct" | "lowWaterPct" | "breakEvenArmed">> = {}) => ({ entryPriceUsd: 1, entryLiquidityUsd: 100_000, highWaterPct: 0, lowWaterPct: 0, breakEvenArmed: false, ...over });

  it("takes profit at +100%", () => {
    assert.equal(evaluateGuard(pos(), { priceUsd: 2, liquidityUsd: 100_000 }).exit, "TAKE_PROFIT");
    assert.equal(evaluateGuard(pos(), { priceUsd: 1.99, liquidityUsd: 100_000 }).exit, undefined);
  });

  it("cuts losses at -30%", () => {
    const g = evaluateGuard(pos(), { priceUsd: 0.7, liquidityUsd: 100_000 });
    assert.equal(g.exit, "STOP_LOSS");
    assert.equal(evaluateGuard(pos(), { priceUsd: 0.71, liquidityUsd: 100_000 }).exit, undefined);
    assert.equal(g.stopPct, GUARD.stopLossPct);
  });

  it("arms break-even at +50% and then stops out at 0%", () => {
    const up = evaluateGuard(pos(), { priceUsd: 1.5, liquidityUsd: 100_000 });
    assert.equal(up.breakEvenArmed, true);
    assert.equal(up.stopPct, 0);
    assert.equal(up.exit, undefined, "still open at +50%");
    const back = evaluateGuard(pos({ highWaterPct: up.highWaterPct, breakEvenArmed: true }), { priceUsd: 1.0, liquidityUsd: 100_000 });
    assert.equal(back.exit, "BREAK_EVEN_STOP");
    // Once armed, a -10% reading no longer waits for -30%.
    assert.equal(evaluateGuard(pos({ highWaterPct: 60, breakEvenArmed: true }), { priceUsd: 0.9, liquidityUsd: 100_000 }).exit, "BREAK_EVEN_STOP");
    // Not armed: -10% is just a drawdown.
    assert.equal(evaluateGuard(pos(), { priceUsd: 0.9, liquidityUsd: 100_000 }).exit, undefined);
  });

  it("arms and exits in the same observation when the first look is already below break-even", () => {
    const g = evaluateGuard(pos({ highWaterPct: 55, breakEvenArmed: true }), { priceUsd: 0.95 });
    assert.equal(g.exit, "BREAK_EVEN_STOP");
  });

  it("triggers an emergency exit when liquidity falls more than 20% from entry", () => {
    assert.equal(evaluateGuard(pos(), { priceUsd: 1.1, liquidityUsd: 79_000 }).exit, "EMERGENCY_LIQUIDITY");
    assert.equal(evaluateGuard(pos(), { priceUsd: 1.1, liquidityUsd: 80_001 }).exit, undefined);
  });

  it("emergency takes priority over take-profit and stop-loss", () => {
    assert.equal(evaluateGuard(pos(), { priceUsd: 5, liquidityUsd: 10_000 }).exit, "EMERGENCY_LIQUIDITY");
    assert.equal(evaluateGuard(pos(), { priceUsd: 0.5, liquidityUsd: 10_000 }).exit, "EMERGENCY_LIQUIDITY");
  });

  it("tracks high and low water marks and ignores a missing liquidity reading", () => {
    const g = evaluateGuard(pos({ highWaterPct: 20, lowWaterPct: -5 }), { priceUsd: 0.9 });
    assert.equal(g.highWaterPct, 20);
    assert.ok(Math.abs(g.lowWaterPct - -10) < 1e-9);
    assert.equal(g.exit, undefined);
  });
});

describe("fill simulation", () => {
  const pair = makePair({ addr: "So11111111111111111111111111111111111111113", priceUsd: "2", liquidity: { usd: 100_000 } });
  const solana = { ...pair, chainId: "solana" };

  it("uses the Jupiter quote and adds slippage on top (buy)", async () => {
    const clock = fakeTime();
    // 1 SOL = $100 -> $50 buys 0.5 SOL -> quote returns 25_000_000 raw (9 dec) = 0.025 tokens ... use 6 decimals: 25 tokens.
    const { fn } = mockFetch(() => ({ body: { ...quoteBody, inAmount: "500000000", outAmount: "25000000" } }));
    const jupiter = new JupiterClient({ fetchImpl: fn, now: clock.now, sleep: clock.sleep, retries: 0 });
    const fill = await simulateBuyFill({ jupiter, pair: solana, slippageBps: 200, decimals: 6, solPriceUsd: 100 }, 50);
    assert.equal(fill.source, "jupiter");
    assert.equal(fill.refPriceUsd, 2);
    // $50 / 25 tokens = $2.00 quote price, +2% slippage
    assert.ok(Math.abs(fill.fillPriceUsd - 2.04) < 1e-9, String(fill.fillPriceUsd));
  });

  it("deducts slippage from sells", async () => {
    const clock = fakeTime();
    // sell 25 tokens -> 0.5 SOL = $50 -> $2/token, -2%
    const { fn } = mockFetch(() => ({ body: { ...quoteBody, outAmount: "500000000" } }));
    const jupiter = new JupiterClient({ fetchImpl: fn, now: clock.now, sleep: clock.sleep, retries: 0 });
    const fill = await simulateSellFill({ jupiter, pair: solana, slippageBps: 200, decimals: 6, solPriceUsd: 100 }, 25);
    assert.ok(Math.abs(fill.fillPriceUsd - 1.96) < 1e-9);
  });

  it("falls back to the liquidity model (with a note) when Jupiter fails or decimals are unknown", async () => {
    const clock = fakeTime();
    const { fn } = mockFetch(() => ({ status: 503 }));
    const jupiter = new JupiterClient({ fetchImpl: fn, now: clock.now, sleep: clock.sleep, retries: 0 });
    const a = await simulateBuyFill({ jupiter, pair: solana, slippageBps: 200, decimals: 6, solPriceUsd: 100 }, 1000);
    assert.equal(a.source, "model");
    assert.match(a.notes.join(" "), /Jupiter quote unavailable/);
    const impact = modelImpact(1000, 100_000);
    assert.ok(Math.abs(a.fillPriceUsd - 2 * (1 + impact) * 1.02) < 1e-9);
    const b = await simulateBuyFill({ jupiter, pair: solana, slippageBps: 200, solPriceUsd: 100 }, 1000);
    assert.match(b.notes.join(" "), /decimals unknown/);
    const evm = await simulateBuyFill({ pair: { ...pair, chainId: "base" }, slippageBps: 200 }, 100);
    assert.match(evm.notes[0]!, /Non-Solana/);
  });

  it("models impact conservatively and prices fees from lamports", () => {
    assert.ok(modelImpact(5_000, 100_000) > 0.09 && modelImpact(5_000, 100_000) < 0.1);
    assert.ok(modelImpact(1e9, 100) < 1);
    // (5000 + 500000) lamports at $100/SOL
    assert.ok(Math.abs(feesUsd(500_000, 100) - 0.0505) < 1e-9);
  });

  it("rejects a pair without a usable price", async () => {
    await assert.rejects(simulateBuyFill({ pair: { ...pair, priceUsd: undefined }, slippageBps: 200 }, 10), /usable priceUsd/);
  });
});

describe("live guardrails", () => {
  const full = { SOLANA_BURNER_PRIVATE_KEY: "k", DEX_ALPHA_ALLOW_LIVE_EXECUTION: "true", MAX_TRADE_USD: "50", DAILY_LOSS_LIMIT_USD: "100" };

  it("allows auto-execution only with every setting present", () => {
    assert.deepEqual(autoExecutionProblems(readLiveConfig(full), "buy", 25, 0), []);
    assert.equal(autoExecutionProblems(readLiveConfig({}), "buy", 25, 0).length, 4);
    for (const missing of Object.keys(full)) {
      const env = { ...full } as Record<string, string | undefined>;
      delete env[missing];
      assert.ok(autoExecutionProblems(readLiveConfig(env), "buy", 25, 0).some((p) => p.includes(missing)), missing);
    }
  });

  it("treats non-numeric or non-positive limits as missing (fail-closed)", () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      assert.ok(autoExecutionProblems(readLiveConfig({ ...full, MAX_TRADE_USD: bad }), "buy", 1, 0).some((p) => /MAX_TRADE_USD/.test(p)), bad);
    }
    assert.ok(autoExecutionProblems(readLiveConfig({ ...full, DEX_ALPHA_ALLOW_LIVE_EXECUTION: "yes" }), "buy", 1, 0).length > 0);
  });

  it("caps trade size and stops buys at the daily loss limit, but never blocks exits for them", () => {
    const cfg = readLiveConfig(full);
    assert.match(autoExecutionProblems(cfg, "buy", 51, 0)[0]!, /exceeds MAX_TRADE_USD/);
    assert.deepEqual(autoExecutionProblems(cfg, "buy", 50, 99.99), []);
    assert.match(autoExecutionProblems(cfg, "buy", 10, 100)[0]!, /DAILY_LOSS_LIMIT_USD/);
    assert.deepEqual(autoExecutionProblems(cfg, "sell", 9999, 9999), []);
  });
});

describe("TradeLedger", () => {
  const dirs: string[] = [];
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), "dar-ledger-"));
    dirs.push(d);
    return d;
  };
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const base = (over: Partial<Position> = {}): Omit<Position, "id"> => ({
    mode: "paper",
    status: "open",
    chain: "solana",
    tokenAddress: "T",
    symbol: "TKN",
    pairAddress: "P",
    openedAt: "2026-11-18T10:00:00.000Z",
    sizeUsd: 100,
    entryFeesUsd: 0.1,
    tokenQty: 10,
    entryRefPriceUsd: 10,
    entryPriceUsd: 10.2,
    slippageBps: 200,
    priorityFeeLamports: 500_000,
    fillSource: "model",
    entryLiquidityUsd: 50_000,
    entry: { ageMinutes: 3, alphaScore: 75, security: "SAFE", forensics: "CLEAN_DISTRIBUTION", holderSafetyScore: 90, copycatRisk: "NONE", rulesEnforced: true, rulesPassed: true },
    highWaterPct: 0,
    lowWaterPct: 0,
    breakEvenArmed: false,
    ...over,
  });

  it("persists positions across instances with owner-only permissions and no temp files left", () => {
    const dir = temp();
    const path = join(dir, "sub", "trades.json");
    const l1 = new TradeLedger(path);
    const p = l1.add(base());
    assert.equal(l1.list().length, 1);
    assert.equal(new TradeLedger(path).get(p.id)?.symbol, "TKN");
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "sub")).mode & 0o777, 0o700);
    }
    assert.deepEqual(readdirSync(join(dir, "sub")), ["trades.json"]);
  });

  it("filters by status, mode and date; update is read-modify-write", () => {
    const l = new TradeLedger(join(temp(), "t.json"));
    const a = l.add(base());
    l.add(base({ mode: "live", openedAt: "2026-11-10T00:00:00.000Z" }));
    assert.equal(l.list({ mode: "paper" }).length, 1);
    assert.equal(l.list({ mode: "all" }).length, 2);
    assert.equal(l.list({ since: Date.parse("2026-11-15") }).length, 1);
    l.update(a.id, (x) => void (x.status = "closed"));
    assert.equal(l.list({ status: "open", mode: "all" }).length, 1);
    assert.equal(l.update("nope", () => undefined), undefined);
  });

  it("moves a corrupt file aside instead of overwriting it", () => {
    const dir = temp();
    const path = join(dir, "trades.json");
    writeFileSync(path, "{not json");
    const l = new TradeLedger(path);
    assert.deepEqual(l.list(), []);
    const files = readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith("trades.json.corrupt-")), files.join(","));
    assert.equal(readFileSync(join(dir, files.find((f) => f.includes("corrupt"))!), "utf8"), "{not json");
    l.add(base());
    assert.equal(l.list().length, 1);
  });

  it("returns an empty ledger when the file does not exist and creates nothing on read", () => {
    const dir = temp();
    const l = new TradeLedger(join(dir, "none", "t.json"));
    assert.deepEqual(l.list(), []);
    assert.equal(existsSync(join(dir, "none")), false);
  });

  it("sums only today's realised live losses", () => {
    const l = new TradeLedger(join(temp(), "t.json"));
    const closed = (mode: "paper" | "live", at: string, pnlUsd: number) =>
      l.add(base({ mode, status: "closed", exit: { at, priceUsd: 1, refPriceUsd: 1, reason: "STOP_LOSS", feesUsd: 0, pnlUsd, pnlPct: pnlUsd, fillSource: "model" } }));
    const now = Date.parse("2026-11-18T12:00:00Z");
    closed("live", "2026-11-18T09:00:00Z", -30);
    closed("live", "2026-11-18T10:00:00Z", -12.5);
    closed("live", "2026-11-18T11:00:00Z", +80); // a win does not offset the loss limit
    closed("live", "2026-11-17T23:59:00Z", -500); // yesterday
    closed("paper", "2026-11-18T09:00:00Z", -999); // paper is separate
    assert.equal(l.dailyRealizedLossUsd("live", now), 42.5);
  });
});
