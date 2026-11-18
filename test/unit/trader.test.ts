import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "node:crypto";
import { after, describe, it } from "node:test";
import { DexScreenerClient } from "../../mcp-server/src/dexscreener.js";
import { createServer } from "../../mcp-server/src/index.js";
import { SecurityAuditor } from "../../mcp-server/src/security.js";
import type { ToolDeps } from "../../mcp-server/src/tools/index.js";
import { monitorPositions, simulateOrPrepareTrade, startPaperMonitor, type TradeParams } from "../../mcp-server/src/tools/paper-phantom-trader.js";
import { JupiterClient, WSOL_MINT } from "../../mcp-server/src/trading/jupiter.js";
import { TradeLedger } from "../../mcp-server/src/trading/ledger.js";
import { base58Decode, SolanaRpc } from "../../mcp-server/src/trading/solana.js";
import { fakeTime, makePair, mockFetch, NOW } from "../helpers.js";
import { fakeTx, newKeypair } from "../solana-helpers.js";

const MINT = ("TradMint" + "1".repeat(40)).slice(0, 43);
const PAIR = ("TradPair" + "1".repeat(40)).slice(0, 43);
const OLD = ("OldeMint" + "1".repeat(40)).slice(0, 43);

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface World {
  price: number;
  liq: number;
  sol: number;
  ageMin: number;
  /** Jupiter v6 host is unreachable (as observed) -> the lite host serves. */
  v6Down: boolean;
  jupiterDown: boolean;
  mintAuth: string | null;
  graphInsiders: number;
  reportDown: boolean;
  /** Extra pairs returned by tokens/v1 (when requested) and appended to search results. */
  extraPairs: ReturnType<typeof makePair>[];
  boosts: { chainId: string; tokenAddress: string }[];
  /** SPL balance (raw) of any wallet. */
  balanceRaw: string;
  simErr: unknown;
  sendMessage?: string;
  sigStatus: "confirmed" | "failed" | "pending";
  sent: string[];
  swapCalls: number;
  rpcMethods: string[];
}

function world(over: Partial<World> = {}) {
  const w: World = { price: 0.00001234, liq: 80_000, sol: 100, ageMin: 3, v6Down: true, jupiterDown: false, mintAuth: null, graphInsiders: 0, reportDown: false, extraPairs: [], boosts: [], balanceRaw: "2000000000000", simErr: null, sigStatus: "confirmed", sent: [], swapCalls: 0, rpcMethods: [], ...over };
  const tokenPair = () => makePair({ addr: MINT, baseToken: { address: MINT, name: "Trade Coin", symbol: "TRD" }, pairAddress: PAIR, priceUsd: String(w.price), liquidity: { usd: w.liq }, pairCreatedAt: NOW - w.ageMin * 60_000 });
  const wsol = makePair({ addr: WSOL_MINT, baseToken: { address: WSOL_MINT, name: "Wrapped SOL", symbol: "SOL" }, pairAddress: "wsolpair", priceUsd: String(w.sol), liquidity: { usd: 50_000_000 } });

  const handler: Parameters<typeof mockFetch>[0] = (u, _n, body) => {
    // ---- Solana RPC ----
    if (u.startsWith("https://api.mainnet-beta.solana.com")) {
      const m = body?.method as string;
      w.rpcMethods.push(m);
      const ok = (result: unknown) => ({ body: { jsonrpc: "2.0", id: 1, result } });
      if (m === "getTokenSupply") return ok({ value: { decimals: 6 } });
      if (m === "getTokenAccountsByOwner") return ok({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: w.balanceRaw, decimals: 6 } } } } } }] });
      if (m === "simulateTransaction") return ok({ value: { err: w.simErr, logs: ["log"] } });
      if (m === "sendTransaction") {
        if (w.sendMessage) return { body: { jsonrpc: "2.0", id: 1, error: { code: -32002, message: w.sendMessage } } };
        w.sent.push(body.params[0]);
        return ok("SIGNATURE_" + w.sent.length);
      }
      if (m === "getSignatureStatuses") return ok({ value: [w.sigStatus === "pending" ? null : { err: w.sigStatus === "failed" ? { InstructionError: [0, "x"] } : null, confirmationStatus: "confirmed" }] });
      return undefined;
    }
    // ---- Jupiter ----
    if (u.includes("jup.ag")) {
      if (w.jupiterDown || (w.v6Down && u.startsWith("https://quote-api.jup.ag"))) return { throws: new TypeError("fetch failed") };
      if (u.includes("/quote")) {
        const q = new URL(u).searchParams;
        const amt = BigInt(q.get("amount")!);
        const isBuy = q.get("inputMint") === WSOL_MINT;
        const out = isBuy ? BigInt(Math.floor(((Number(amt) / 1e9) * w.sol / w.price) * 1e6 * 0.997)) : BigInt(Math.floor((((Number(amt) / 1e6) * w.price) / w.sol) * 1e9 * 0.997));
        return { body: { inputMint: q.get("inputMint"), inAmount: String(amt), outputMint: q.get("outputMint"), outAmount: String(out), otherAmountThreshold: String((out * 98n) / 100n), slippageBps: Number(q.get("slippageBps")), priceImpactPct: "0.004" } };
      }
      if (u.endsWith("/swap")) {
        w.swapCalls++;
        return { body: { swapTransaction: fakeTx([Buffer.from(base58Decode(body.userPublicKey)), Buffer.alloc(32, 5)]).b64, lastValidBlockHeight: 999 } };
      }
    }
    // ---- RugCheck ----
    if (u.includes("rugcheck.xyz")) {
      if (u.endsWith("/report/summary")) return { body: { score_normalised: 2, risks: [], lpLockedPct: 95 } };
      if (w.reportDown) return { status: 500 };
      return {
        body: {
          score_normalised: 2,
          risks: [],
          mintAuthority: w.mintAuth,
          freezeAuthority: null,
          token: { supply: 1e15, decimals: 6 },
          totalHolders: 900,
          creator: "CREATOR",
          creatorBalance: 0,
          graphInsidersDetected: w.graphInsiders,
          insiderNetworks: [],
          topHolders: [3, 2.5, 2, 1.5, 1].map((pct, i) => ({ address: `a${i}`, owner: `w${i}`, pct, insider: false })),
          knownAccounts: {},
          markets: [],
        },
      };
    }
    // ---- DexScreener ----
    if (u.includes("/tokens/v1/solana/")) {
      const ids = u.split("/tokens/v1/solana/")[1]!;
      return { body: [...(ids.includes(WSOL_MINT) ? [wsol] : []), ...(ids.includes(MINT) ? [tokenPair()] : []), ...w.extraPairs.filter((p) => ids.includes(p.baseToken.address))] };
    }
    if (u.includes("/latest/dex/pairs/solana/")) return { body: { pairs: u.includes(PAIR) ? [tokenPair()] : [] } };
    if (u.includes("/latest/dex/search")) return { body: { pairs: [tokenPair(), ...w.extraPairs] } };
    if (u.includes("/token-boosts/latest")) return { body: w.boosts };
    if (u.includes("/token-boosts/top") || u.includes("/token-profiles") || u.includes("/community-takeovers")) return { body: [] };
    return undefined;
  };

  const dir = mkdtempSync(join(tmpdir(), "dar-trader-"));
  dirs.push(dir);
  const mk = (envOver: Record<string, string> = {}) => {
    const clock = fakeTime(NOW);
    const { fn, calls, bodies } = mockFetch(handler);
    const o = { fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 1, retries: 0 };
    const ledger = new TradeLedger(join(dir, "trades.json"));
    const deps: ToolDeps = {
      dex: new DexScreenerClient(o),
      security: new SecurityAuditor(o),
      jupiter: new JupiterClient(o),
      rpc: new SolanaRpc({ fetchImpl: fn, sleep: clock.sleep, retries: 0 }),
      ledger,
      env: envOver,
      now: clock.now,
    };
    return { deps, calls, bodies, ledger, clock };
  };
  return { w, mk, dir, tokenPair };
}

const trade = (deps: ToolDeps, p: Partial<TradeParams> & { action: TradeParams["action"] }) => simulateOrPrepareTrade(deps, p as TradeParams);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe("paper buy (default mode)", () => {
  it("opens a simulated position with Jupiter-quoted price, 2% slippage and Solana fees", async () => {
    const { w, mk } = world();
    const { deps, ledger } = mk();
    const r: Any = await trade(deps, { action: "buy", tokenAddress: MINT, sizeUsd: 25 }); // paperMode omitted -> true
    assert.equal(r.executed, true);
    assert.equal(r.paperMode, true);
    assert.equal(r.fill.source, "jupiter");
    // quote price = ref / 0.997; fill adds 2% slippage
    const expected = (w.price / 0.997) * 1.02;
    assert.ok(Math.abs(r.fill.fillPriceUsd / expected - 1) < 1e-4, `${r.fill.fillPriceUsd} vs ${expected}`);
    assert.equal(r.fill.slippageBps, 200);
    assert.ok(r.fill.effectiveSlippageVsMarketPct > 2.0 && r.fill.effectiveSlippageVsMarketPct < 2.6);
    // (5000 + 500000 lamports) at $100/SOL
    assert.ok(Math.abs(r.fill.entryFeesUsd - 0.0505) < 1e-4);
    assert.equal(r.context.security, "SAFE");
    assert.equal(r.context.forensics, "CLEAN_DISTRIBUTION");
    assert.ok(r.context.alphaScore >= 70);
    assert.equal(r.context.copycatRisk, "NONE");
    assert.equal(r.guard.takeProfitPct, 100);
    assert.equal(r.guard.stopLossPct, -30);
    const pos = ledger.list()[0]!;
    assert.equal(pos.status, "open");
    assert.equal(pos.mode, "paper");
    assert.equal(pos.decimals, 6);
    assert.ok(Math.abs(pos.tokenQty * pos.entryPriceUsd - 25) < 1e-6);
    assert.equal(pos.entry.rulesEnforced, true);
    assert.equal(pos.entry.ageMinutes, 3);
    assert.match(r.note, /SIMULATION/);
  });

  it("persists to the JSON ledger file", async () => {
    const { mk, dir } = world();
    const { deps } = mk();
    await trade(deps, { action: "buy", tokenAddress: MINT });
    const file = JSON.parse(readFileSync(join(dir, "trades.json"), "utf8"));
    assert.equal(file.version, 1);
    assert.equal(file.positions[0].symbol, "TRD");
  });

  it("falls back to the liquidity model when Jupiter is unreachable, and says so", async () => {
    const { mk } = world({ jupiterDown: true });
    const r: Any = await trade(mk().deps, { action: "buy", tokenAddress: MINT, sizeUsd: 1000 });
    assert.equal(r.executed, true);
    assert.equal(r.fill.source, "model");
    assert.match(r.fill.notes.join(" "), /Jupiter quote unavailable/);
    assert.ok(r.fill.fillPriceUsd > r.fill.refPriceUsd * 1.02, "impact + slippage");
  });

  it("falls back to the lite Jupiter host when v6 is down (the observed behaviour)", async () => {
    const { mk, w } = world();
    const { deps, calls } = mk();
    await trade(deps, { action: "buy", tokenAddress: MINT });
    assert.ok(calls.some((u) => u.startsWith("https://lite-api.jup.ag/swap/v1/quote")));
    assert.equal(w.v6Down, true);
    assert.equal(deps.jupiter!.lastBase, "https://lite-api.jup.ag/swap/v1");
  });

  it("validates inputs", async () => {
    const { mk } = world();
    const { deps } = mk();
    await assert.rejects(trade(deps, { action: "buy" }), /tokenAddress is required/);
    await assert.rejects(trade(deps, { action: "buy", tokenAddress: MINT, sizeUsd: -5 }), /sizeUsd/);
    await assert.rejects(trade(deps, { action: "buy", tokenAddress: MINT, slippageBps: 99999 }), /slippageBps/);
    await assert.rejects(trade(deps, { action: "buy", tokenAddress: "not-a-mint-at-all-but-long-enough-xx" }), /not a valid Solana mint/);
    await assert.rejects(trade(deps, { action: "sell", tokenAddress: MINT }), /No open paper position/);
  });
});

describe("entry rules gate", () => {
  it("blocks (and records nothing) when the pair is older than 5 minutes", async () => {
    const { mk, dir } = world({ ageMin: 60 });
    const r: Any = await trade(mk().deps, { action: "buy", tokenAddress: MINT });
    assert.equal(r.executed, false);
    assert.equal(r.blocked, true);
    assert.ok(r.failed.some((f: string) => f.startsWith("age:")));
    assert.equal(r.checks.length, 5);
    assert.equal(existsSync(join(dir, "trades.json")), false, "nothing written");
    assert.match(r.hint, /enforceEntryRules=false/);
  });

  it("blocks when security is not SAFE (active mint authority)", async () => {
    const { mk } = world({ mintAuth: "Auth111111111111111111111111111111111111" });
    const r: Any = await trade(mk().deps, { action: "buy", tokenAddress: MINT });
    assert.equal(r.blocked, true);
    assert.ok(r.failed.some((f: string) => f.startsWith("security:")));
  });

  it("blocks a bundled launch", async () => {
    const { mk } = world({ graphInsiders: 25 });
    const r: Any = await trade(mk().deps, { action: "buy", tokenAddress: MINT });
    assert.ok(r.failed.some((f: string) => f.startsWith("noBundle:") && f.includes("BUNDLE_DETECTED")));
  });

  it("is fail-closed when holder forensics are unavailable", async () => {
    const { mk } = world({ reportDown: true });
    const r: Any = await trade(mk().deps, { action: "buy", tokenAddress: MINT });
    assert.equal(r.blocked, true);
    assert.ok(r.failed.some((f: string) => /INSUFFICIENT_DATA \(fail-closed\)/.test(f)));
  });

  it("blocks a late copycat of a trending token", async () => {
    const original = makePair({ addr: OLD, baseToken: { address: OLD, name: "Trade Coin", symbol: "TRD" }, pairCreatedAt: NOW - 600 * 60_000, liquidity: { usd: 900_000 }, volume: { h24: 5_000_000, h1: 300_000, m5: 20_000 } });
    const { mk, w } = world();
    w.extraPairs = [original];
    w.boosts = [{ chainId: "solana", tokenAddress: OLD }]; // the original is trending
    const r: Any = await trade(mk().deps, { action: "buy", tokenAddress: MINT });
    assert.equal(r.blocked, true);
    assert.equal(r.context.copycatRisk, "HIGH");
    assert.ok(r.failed.some((f: string) => f.startsWith("noCopycat:")), JSON.stringify(r.failed));
  });

  it("paper trades may bypass the gate explicitly; the trade is flagged experimental", async () => {
    const { mk } = world({ ageMin: 90 });
    const { deps, ledger } = mk();
    const r: Any = await trade(deps, { action: "buy", tokenAddress: MINT, enforceEntryRules: false });
    assert.equal(r.executed, true);
    assert.ok(r.warnings.some((x: string) => /Entry rules were bypassed/.test(x)));
    const pos = ledger.list()[0]!;
    assert.equal(pos.entry.rulesEnforced, false);
    assert.equal(pos.entry.rulesPassed, false);
  });

  it("live trades can never bypass the gate", async () => {
    const { mk } = world({ ageMin: 90 });
    await assert.rejects(trade(mk().deps, { action: "buy", tokenAddress: MINT, paperMode: false, enforceEntryRules: false, walletPublicKey: newKeypair().pubBase58 }), /cannot be disabled for live/);
    const r: Any = await trade(mk().deps, { action: "buy", tokenAddress: MINT, paperMode: false, walletPublicKey: newKeypair().pubBase58 });
    assert.equal(r.blocked, true, "an old pair is blocked in live mode too");
  });
});

describe("Trailing Profit Guard via monitor", () => {
  async function open(over: Partial<World> = {}) {
    const wd = world(over);
    const m = wd.mk();
    await trade(m.deps, { action: "buy", tokenAddress: MINT, sizeUsd: 100 });
    return { ...wd, ...m };
  }
  const monitor = (deps: ToolDeps) => trade(deps, { action: "monitor" }) as Promise<Any>;

  it("holds while inside the band and tracks the high-water mark", async () => {
    const t = await open();
    t.w.price *= 1.2;
    const r = await monitor(t.deps);
    assert.equal(r.closed.length, 0);
    assert.equal(r.holding.length, 1);
    assert.ok(r.holding[0].highWaterPct > 15 && r.holding[0].highWaterPct < 20, String(r.holding[0].highWaterPct));
    assert.equal(r.holding[0].stopPct, -30);
  });

  it("takes profit at +100% with slippage and fees reflected in the PnL", async () => {
    const t = await open();
    t.w.price *= 2.1;
    const r = await monitor(t.deps);
    assert.equal(r.closed.length, 1);
    const c = r.closed[0];
    assert.equal(c.exit.reason, "TAKE_PROFIT");
    // gross mark gain is ~105% vs the slippage-inclusive entry; costs (exit slippage, route impact, fees) bring it a little lower
    assert.ok(c.pnlPct > 95 && c.pnlPct < 105, `pnl ${c.pnlPct}`);
    assert.ok(c.pnlUsd > 0);
    assert.equal(t.ledger.list({ status: "open" }).length, 0);
    assert.equal((await monitor(t.deps)).checked, 0, "closed positions are not checked again");
  });

  it("cuts losses at -30%", async () => {
    const t = await open();
    t.w.price *= 0.62; // vs entry (which already includes ~2.3% cost) this is below -30%
    const r = await monitor(t.deps);
    assert.equal(r.closed[0].exit.reason, "STOP_LOSS");
    assert.ok(r.closed[0].pnlPct < -30);
  });

  it("moves the stop to break-even at +50%, then exits at 0% when the move fades", async () => {
    const t = await open();
    t.w.price *= 1.6;
    const up = await monitor(t.deps);
    assert.equal(up.closed.length, 0);
    assert.equal(up.holding[0].breakEvenArmed, true);
    assert.equal(up.holding[0].stopPct, 0);
    t.clock.advance(15_000); // let DexScreener's 12 s response cache expire
    t.w.price /= 1.6; // back to the entry reference: slightly below the (slippage-inclusive) fill
    const down = await monitor(t.deps);
    assert.equal(down.closed.length, 1);
    assert.equal(down.closed[0].exit.reason, "BREAK_EVEN_STOP");
    assert.ok(down.closed[0].pnlPct < 0 && down.closed[0].pnlPct > -8, `loss limited to costs: ${down.closed[0].pnlPct}`);
  });

  it("without the +50% trigger a -10% dip does NOT exit", async () => {
    const t = await open();
    t.w.price *= 0.92;
    assert.equal((await monitor(t.deps)).closed.length, 0);
  });

  it("emergency-exits when liquidity drops more than 20%, even at a profit, with doubled slippage", async () => {
    const t = await open();
    t.w.liq = 55_000; // -31%
    t.w.price *= 1.3;
    const r = await monitor(t.deps);
    assert.equal(r.closed[0].exit.reason, "EMERGENCY_LIQUIDITY");
    // 4% slippage rather than 2%: compare against a calm exit at the same price
    const calm = await open();
    calm.w.price *= 1.3;
    await trade(calm.deps, { action: "sell", tokenAddress: MINT });
    const calmPos = calm.ledger.list({ status: "closed" })[0]!;
    const emergencyPos = t.ledger.list({ status: "closed" })[0]!;
    assert.ok(emergencyPos.exit!.priceUsd < calmPos.exit!.priceUsd, "panic exit fills worse");
    t.w.liq = 70_000; // (not applicable now; position closed)
  });

  it("a liquidity drop of 15% is tolerated", async () => {
    const t = await open();
    t.w.liq = 68_000;
    assert.equal((await monitor(t.deps)).closed.length, 0);
  });

  it("reports positions it cannot price instead of guessing", async () => {
    const t = await open();
    t.w.price = 0;
    const r = await monitor(t.deps);
    assert.equal(r.noPrice.length, 1);
    assert.equal(r.closed.length, 0);
  });

  it("the background paper monitor closes triggered paper positions on its own", async () => {
    const t = await open();
    t.w.price *= 2.5;
    const stop = startPaperMonitor(t.deps, 15);
    try {
      for (let i = 0; i < 100 && t.ledger.list({ status: "open" }).length; i++) await new Promise((r) => setTimeout(r, 20));
    } finally {
      stop();
    }
    assert.equal(t.ledger.list({ status: "closed" })[0]?.exit?.reason, "TAKE_PROFIT");
  });

  it("manual sell closes at market minus slippage; positions lists the ledger", async () => {
    const t = await open();
    t.w.price *= 1.1;
    const s: Any = await trade(t.deps, { action: "sell", positionId: t.ledger.list()[0]!.id });
    assert.equal(s.executed, true);
    assert.equal(s.position.exit.reason, "MANUAL");
    assert.ok(s.fill.fillPriceUsd < s.fill.refPriceUsd);
    const list: Any = await trade(t.deps, { action: "positions" });
    assert.equal(list.open.length, 0);
    assert.equal(list.recentClosed.length, 1);
    assert.equal(list.live.autoExecutionReady, false);
    assert.equal(list.live.burnerKeyConfigured, false);
  });
});

describe("live mode: unsigned Phantom transactions", () => {
  it("prepares an unsigned swap for the user's wallet and records nothing", async () => {
    const kp = newKeypair();
    const { mk, w } = world();
    const { deps, ledger, calls } = mk();
    const r: Any = await trade(deps, { action: "buy", tokenAddress: MINT, sizeUsd: 25, paperMode: false, walletPublicKey: kp.pubBase58 });
    assert.equal(r.executed, false);
    assert.equal(r.prepared, true);
    assert.equal(r.wallet, kp.pubBase58);
    const tx = Buffer.from(r.unsignedTransactionBase64, "base64");
    assert.deepEqual(tx.subarray(1, 65), Buffer.alloc(64), "signature slot is empty: nothing was signed");
    assert.ok(tx.includes(kp.pub), "the swap is built for the user's wallet");
    assert.equal(r.quote.inputSol, 0.25);
    assert.ok(r.quote.expectedTokens > r.quote.minimumTokens);
    assert.equal(r.quote.jupiterHost, "https://lite-api.jup.ag/swap/v1");
    assert.equal(r.lastValidBlockHeight, 999);
    assert.ok(r.instructions.length >= 3);
    assert.equal(ledger.list({ mode: "all" }).length, 0);
    assert.deepEqual(w.sent, []);
    assert.ok(!w.rpcMethods.includes("sendTransaction") && !w.rpcMethods.includes("simulateTransaction"));
    assert.ok(calls.some((u) => u.endsWith("/swap")));
  });

  it("requires a valid wallet, Solana, and respects MAX_TRADE_USD even when only preparing", async () => {
    const { mk } = world();
    const { deps } = mk();
    await assert.rejects(trade(deps, { action: "buy", tokenAddress: MINT, paperMode: false }), /walletPublicKey/);
    await assert.rejects(trade(deps, { action: "buy", tokenAddress: MINT, paperMode: false, walletPublicKey: "nope" }), /walletPublicKey/);
    await assert.rejects(trade(deps, { action: "buy", tokenAddress: "0x" + "1".repeat(40), chain: "base", paperMode: false, walletPublicKey: newKeypair().pubBase58 }), /Solana-only/);
    const capped = mk({ MAX_TRADE_USD: "20" });
    await assert.rejects(trade(capped.deps, { action: "buy", tokenAddress: MINT, sizeUsd: 25, paperMode: false, walletPublicKey: newKeypair().pubBase58 }), /exceeds MAX_TRADE_USD/);
  });

  it("prepares an unsigned sell from the wallet's on-chain balance", async () => {
    const kp = newKeypair();
    const { mk } = world({ balanceRaw: "4000000" });
    const r: Any = await trade(mk().deps, { action: "sell", tokenAddress: MINT, paperMode: false, walletPublicKey: kp.pubBase58, sellPercent: 50 });
    assert.equal(r.prepared, true);
    assert.equal(r.quote.sellRaw, "2000000");
    assert.ok(r.quote.expectedSol > 0);
    assert.ok(Buffer.from(r.unsignedTransactionBase64, "base64").includes(kp.pub));
  });
});

describe("live mode: guard-railed auto-execution", () => {
  const burner = newKeypair();
  const FULL = { SOLANA_BURNER_PRIVATE_KEY: burner.secretBase58, DEX_ALPHA_ALLOW_LIVE_EXECUTION: "true", MAX_TRADE_USD: "50", DAILY_LOSS_LIMIT_USD: "100" };
  const live = (extra: Partial<TradeParams> = {}): Partial<TradeParams> & { action: TradeParams["action"] } => ({ action: "buy", tokenAddress: MINT, sizeUsd: 25, paperMode: false, autoExecute: true, ...extra });

  it("refuses to sign without every guardrail, and says exactly what is missing", async () => {
    const { mk, w } = world();
    const r: Any = await trade(mk({ SOLANA_BURNER_PRIVATE_KEY: burner.secretBase58 }).deps, live());
    assert.equal(r.executed, false);
    assert.equal(r.blocked, true);
    assert.equal(r.problems.length, 3);
    assert.ok(r.problems.some((p: string) => /ALLOW_LIVE_EXECUTION/.test(p)));
    assert.ok(r.problems.some((p: string) => /MAX_TRADE_USD/.test(p)));
    assert.ok(r.problems.some((p: string) => /DAILY_LOSS_LIMIT_USD/.test(p)));
    assert.deepEqual(w.sent, []);
    assert.equal(w.swapCalls, 0, "no transaction was even built");
  });

  it("autoExecute without a burner key is blocked, never silently downgraded", async () => {
    const { mk, w } = world();
    const r: Any = await trade(mk({ ...FULL, SOLANA_BURNER_PRIVATE_KEY: "" }).deps, live({ walletPublicKey: newKeypair().pubBase58 }));
    assert.equal(r.blocked, true);
    assert.ok(r.problems.some((p: string) => /SOLANA_BURNER_PRIVATE_KEY/.test(p)));
    assert.deepEqual(w.sent, []);
  });

  it("signs with the burner key, simulates first, sends, confirms and records a live position", async () => {
    const { mk, w } = world();
    const { deps, ledger } = mk(FULL);
    const r: Any = await trade(deps, live());
    assert.equal(r.executed, true);
    assert.equal(r.autoExecuted, true);
    assert.equal(r.confirmed, true);
    assert.equal(r.paperMode, false);
    assert.equal(r.signature, "SIGNATURE_1");
    assert.match(r.explorer, /solscan\.io\/tx\/SIGNATURE_1/);
    // order: simulate before send
    assert.ok(w.rpcMethods.indexOf("simulateTransaction") < w.rpcMethods.indexOf("sendTransaction"));
    // the transaction that went out is validly signed by the burner
    assert.equal(w.sent.length, 1);
    const raw = Buffer.from(w.sent[0]!, "base64");
    assert.ok(verify(null, raw.subarray(65), burner.publicKey, raw.subarray(1, 65)), "burner signature verifies");
    // ledger
    const pos = ledger.list({ mode: "live" })[0]!;
    assert.equal(pos.status, "open");
    assert.equal(pos.signature, "SIGNATURE_1");
    assert.equal(pos.confirmed, true);
    assert.equal(pos.entry.rulesEnforced, true);
    assert.match(r.note, /LIVE/);
  });

  it("never exposes the secret key in any output or ledger file", async () => {
    const { mk, dir } = world();
    const { deps } = mk(FULL);
    const results = [await trade(deps, live()), await trade(deps, { action: "positions", mode: "all" }), await trade(deps, { action: "monitor", mode: "all" })];
    const blob = JSON.stringify(results) + readFileSync(join(dir, "trades.json"), "utf8");
    assert.ok(!blob.includes(burner.secretBase58), "base58 secret");
    assert.ok(!blob.includes(burner.secret.subarray(0, 32).toString("hex")), "seed hex");
    assert.ok(!blob.includes(burner.secretJson), "json secret");
    const ready: Any = results[1];
    assert.equal(ready.live.burnerKeyConfigured, true);
    assert.equal(ready.live.autoExecutionReady, true);
  });

  it("redacts a secret even if an upstream error message contains it", async () => {
    const { mk } = world({ sendMessage: `bad tx for key ${burner.secretBase58}` });
    await assert.rejects(trade(mk(FULL).deps, live()), (e: Error) => /-32002/.test(e.message) && !e.message.includes(burner.secretBase58) && e.message.includes("[REDACTED]"));
  });

  it("enforces MAX_TRADE_USD and the daily loss limit", async () => {
    const { mk, w } = world();
    await assert.rejects(trade(mk(FULL).deps, live({ sizeUsd: 51 })), /exceeds MAX_TRADE_USD/);
    const { deps, ledger } = mk(FULL);
    ledger.add({
      mode: "live", status: "closed", chain: "solana", tokenAddress: "X", symbol: "X", pairAddress: "P", openedAt: new Date(NOW).toISOString(), sizeUsd: 50, entryFeesUsd: 0, tokenQty: 1, entryRefPriceUsd: 1, entryPriceUsd: 1, slippageBps: 200, priorityFeeLamports: 0, fillSource: "jupiter", entryLiquidityUsd: 1,
      entry: { ageMinutes: 1, alphaScore: 80, security: "SAFE", forensics: "CLEAN_DISTRIBUTION", holderSafetyScore: 90, copycatRisk: "NONE", rulesEnforced: true, rulesPassed: true },
      highWaterPct: 0, lowWaterPct: -50, breakEvenArmed: false,
      exit: { at: new Date(NOW).toISOString(), priceUsd: 0.5, refPriceUsd: 0.5, reason: "STOP_LOSS", feesUsd: 0, pnlUsd: -100, pnlPct: -100, fillSource: "jupiter" },
    });
    const r: Any = await trade(deps, live());
    assert.equal(r.blocked, true);
    assert.match(r.problems[0], /DAILY_LOSS_LIMIT_USD/);
    assert.deepEqual(w.sent, []);
  });

  it("only signs for the burner wallet", async () => {
    const { mk, w } = world();
    await assert.rejects(trade(mk(FULL).deps, live({ walletPublicKey: newKeypair().pubBase58 })), /does not match the burner wallet/);
    assert.deepEqual(w.sent, []);
  });

  it("does not send when the pre-flight simulation fails", async () => {
    const { mk, w } = world({ simErr: { InstructionError: [2, { Custom: 6001 }] } });
    const { deps, ledger } = mk(FULL);
    const r: Any = await trade(deps, live());
    assert.equal(r.executed, false);
    assert.match(r.reason, /simulation failed/);
    assert.deepEqual(w.sent, []);
    assert.equal(ledger.list({ mode: "all" }).length, 0);
  });

  it("does not record a position for a transaction that failed on-chain", async () => {
    const { mk } = world({ sigStatus: "failed" });
    const { deps, ledger } = mk(FULL);
    const r: Any = await trade(deps, live());
    assert.equal(r.failed, true);
    assert.equal(r.executed, false);
    assert.equal(ledger.list({ mode: "all" }).length, 0);
  });

  it("refuses a malformed burner key without echoing it", async () => {
    const { mk } = world();
    await assert.rejects(trade(mk({ ...FULL, SOLANA_BURNER_PRIVATE_KEY: "super-secret-but-malformed-key-value" }).deps, live()), (e: Error) => /not a valid base58/.test(e.message) && !e.message.includes("super-secret"));
  });
});

describe("live positions: monitor and exits", () => {
  const burner = newKeypair();
  const FULL = { SOLANA_BURNER_PRIVATE_KEY: burner.secretBase58, DEX_ALPHA_ALLOW_LIVE_EXECUTION: "true", MAX_TRADE_USD: "50", DAILY_LOSS_LIMIT_USD: "100" };

  async function openLive(env: Record<string, string> = FULL) {
    const wd = world();
    const m = wd.mk(env);
    await trade(m.deps, { action: "buy", tokenAddress: MINT, sizeUsd: 25, paperMode: false, autoExecute: true });
    wd.w.sent.length = 0;
    wd.w.rpcMethods.length = 0;
    return { ...wd, ...m };
  }

  it("raises an exit signal for a live position but never sells without an explicit autoExecute", async () => {
    const t = await openLive();
    t.w.price *= 0.5;
    const r: Any = await trade(t.deps, { action: "monitor", mode: "live" });
    assert.equal(r.closed.length, 0);
    assert.equal(r.exitSignals[0].reason, "STOP_LOSS");
    assert.deepEqual(t.w.sent, []);
    assert.equal(t.ledger.list({ status: "open", mode: "live" }).length, 1);
  });

  it("the background paper monitor never touches live positions", async () => {
    const t = await openLive();
    t.w.price *= 0.4;
    const stop = startPaperMonitor(t.deps, 10);
    await new Promise((r) => setTimeout(r, 120));
    stop();
    assert.equal(t.ledger.list({ status: "open", mode: "live" }).length, 1);
    assert.deepEqual(t.w.sent, []);
  });

  it("auto-exits a live position when asked, signing and recording the close", async () => {
    const t = await openLive();
    t.w.price *= 0.5;
    const r: Any = await trade(t.deps, { action: "monitor", mode: "live", autoExecute: true });
    assert.equal(r.closed.length, 1, JSON.stringify(r.exitSignals));
    assert.equal(r.closed[0].exit.reason, "STOP_LOSS");
    assert.equal(t.w.sent.length, 1);
    const raw = Buffer.from(t.w.sent[0]!, "base64");
    assert.ok(verify(null, raw.subarray(65), burner.publicKey, raw.subarray(1, 65)));
    assert.ok(r.closed[0].pnlUsd < 0);
    assert.equal(t.ledger.list({ status: "closed", mode: "live" })[0]!.exit!.signature, "SIGNATURE_1");
  });

  it("an auto-exit without guardrails becomes a signal with the reason", async () => {
    const t = await openLive();
    const noGuards = world();
    void noGuards;
    t.w.price *= 0.5;
    const bare = { ...t.deps, env: { SOLANA_BURNER_PRIVATE_KEY: burner.secretBase58 } } as ToolDeps;
    const r: Any = await trade(bare, { action: "monitor", mode: "live", autoExecute: true });
    assert.equal(r.closed.length, 0);
    assert.match(r.exitSignals[0].hint, /Auto-exit blocked/);
    assert.deepEqual(t.w.sent, []);
  });

  it("resolves unconfirmed live buys: confirmed -> tracked; failed -> closed at the fee loss", async () => {
    const t = await openLive();
    const id = t.ledger.list({ mode: "live" })[0]!.id;
    t.ledger.update(id, (p) => void (p.confirmed = false));
    t.w.sigStatus = "pending";
    await monitorPositions(t.deps, { mode: "live" });
    assert.equal(t.ledger.get(id)!.confirmed, false, "still pending: skipped, not guessed");
    t.w.sigStatus = "confirmed";
    await monitorPositions(t.deps, { mode: "live" });
    assert.equal(t.ledger.get(id)!.confirmed, true);

    t.ledger.update(id, (p) => void (p.confirmed = false));
    t.w.sigStatus = "failed";
    await monitorPositions(t.deps, { mode: "live" });
    const p = t.ledger.get(id)!;
    assert.equal(p.status, "closed");
    assert.ok(Math.abs(p.exit!.pnlUsd + p.entryFeesUsd) < 1e-9, "a failed transaction only costs its fees");
  });

  it("a live sell from the tool: tracked positions sell 100% only", async () => {
    const t = await openLive();
    await assert.rejects(trade(t.deps, { action: "sell", tokenAddress: MINT, paperMode: false, autoExecute: true, sellPercent: 50 }), /100%/);
    const r: Any = await trade(t.deps, { action: "sell", tokenAddress: MINT, paperMode: false, autoExecute: true });
    assert.equal(r.executed, true);
    assert.equal(r.position.exit.reason, "MANUAL");
    assert.equal(t.w.sent.length, 1);
  });
});

describe("MCP wiring for the trader and the journal", () => {
  it("validates input with zod, defaults to paper mode and exposes the ledger", async () => {
    const { Client } = await import("../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
    const { InMemoryTransport } = await import("../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js");
    const { mk } = world();
    const { deps } = mk();
    const server = createServer(deps);
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const text = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return { isError: res.isError, text: (res.content as { text: string }[])[0]!.text };
    };

    const bad = await text("simulate_or_prepare_trade", { action: "teleport" });
    assert.equal(bad.isError, true);

    const bought = await text("simulate_or_prepare_trade", { action: "buy", tokenAddress: MINT, sizeUsd: 30 });
    const parsed = JSON.parse(bought.text);
    assert.equal(parsed.paperMode, true);
    assert.equal(parsed.executed, true);

    const j = JSON.parse((await text("analyze_trade_journal", {})).text);
    assert.equal(j.closedTrades, 0);
    assert.equal(j.openPositions, 1);

    const f = JSON.parse((await text("analyze_whale_forensics", { address: MINT })).text);
    assert.equal(f.verdict, "CLEAN_DISTRIBUTION");
    const n = JSON.parse((await text("evaluate_narrative_pulse", { query: MINT })).text);
    assert.equal(n.found, true);
    await client.close();
  });
});

