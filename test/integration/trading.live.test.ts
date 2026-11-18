/**
 * Live checks for forensics, narrative and trading. SAFETY: nothing here can move funds.
 *  - no private key from the environment is ever read (ephemeral in-memory keys only)
 *  - transactions are built and signed locally to validate the format, and are NEVER sent
 *  - paper trades use a throwaway ledger in a temp directory
 */
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DexScreenerClient } from "../../mcp-server/src/dexscreener.js";
import { SecurityAuditor } from "../../mcp-server/src/security.js";
import type { ToolDeps } from "../../mcp-server/src/tools/index.js";
import { evaluateNarrativePulse } from "../../mcp-server/src/tools/narrative-pulse.js";
import { simulateOrPrepareTrade } from "../../mcp-server/src/tools/paper-phantom-trader.js";
import { analyzeTradeJournal } from "../../mcp-server/src/tools/trade-journal.js";
import { analyzeWhaleForensics } from "../../mcp-server/src/tools/whale-forensics.js";
import { JupiterClient, JUPITER_BASES, USDC_MINT, WSOL_MINT } from "../../mcp-server/src/trading/jupiter.js";
import { TradeLedger } from "../../mcp-server/src/trading/ledger.js";
import { createSigner, SolanaRpc } from "../../mcp-server/src/trading/solana.js";
import { newKeypair } from "../solana-helpers.js";
import { probeNetwork } from "./live.js";

const skip = await probeNetwork();
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const tmp: string[] = [];
after(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("Jupiter (live API)", { skip }, () => {
  it("quotes SOL -> USDC and reports which host answered", async (t) => {
    const j = new JupiterClient();
    const q = await j.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 100_000_000n, slippageBps: 200 });
    t.diagnostic(`jupiter host: ${j.lastBase}`);
    console.error(`[live jupiter] answered by ${j.lastBase}`);
    assert.ok(JUPITER_BASES.includes(j.lastBase as (typeof JUPITER_BASES)[number]));
    assert.ok(BigInt(q.outAmount) > 0n);
    assert.ok(BigInt(q.otherAmountThreshold) <= BigInt(q.outAmount));
    assert.equal(q.slippageBps, 200);
  });

  it("builds a real unsigned swap and our signer can sign it locally (never sent)", async () => {
    const j = new JupiterClient();
    const kp = newKeypair();
    const q = await j.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: 50_000_000n, slippageBps: 200 });
    const swap = await j.swap({ quoteResponse: q, userPublicKey: kp.pubBase58, prioritizationFeeLamports: 100_000 });
    const raw = Buffer.from(swap.swapTransaction, "base64");
    assert.deepEqual(raw.subarray(1, 65), Buffer.alloc(64), "unsigned: empty signature slot");
    assert.ok(raw.includes(kp.pub), "built for the requested wallet");
    const signer = createSigner(kp.secretBase58);
    const { signedBase64 } = signer.signTransaction(swap.swapTransaction);
    const signed = Buffer.from(signedBase64, "base64");
    assert.ok(verify(null, signed.subarray(65), kp.publicKey, signed.subarray(1, 65)), "signature over the real Jupiter message verifies");
    // a different wallet's key must be refused
    assert.throws(() => createSigner(newKeypair().secretBase58).signTransaction(swap.swapTransaction), /Refusing to sign/);
  });

  it("rejects an impossible route as a client error without failing over", async () => {
    const j = new JupiterClient();
    await assert.rejects(j.quote({ inputMint: WSOL_MINT, outputMint: "11111111111111111111111111111111", amount: 1000, slippageBps: 200 }), /Jupiter/);
  });
});

describe("Solana RPC (live, read-only)", { skip }, () => {
  it("reads token decimals", async () => {
    const rpc = new SolanaRpc();
    assert.equal(await rpc.getTokenDecimals(USDC_MINT), 6);
    assert.equal(await rpc.getTokenDecimals(BONK), 5);
  });
});

describe("forensics and narrative (live)", { skip }, () => {
  const deps: ToolDeps = { dex: new DexScreenerClient(), security: new SecurityAuditor() };

  it("analyze_whale_forensics returns a typed verdict and a bounded score for BONK", async () => {
    const r = await analyzeWhaleForensics(deps, { address: BONK });
    assert.ok(["BUNDLE_DETECTED", "CLEAN_DISTRIBUTION", "INSUFFICIENT_DATA"].includes(r.verdict));
    if (r.verdict !== "INSUFFICIENT_DATA") {
      assert.ok(r.holderSafetyScore !== null && r.holderSafetyScore >= 0 && r.holderSafetyScore <= 100);
      assert.equal(typeof r.concentration.top10Pct, "number");
      assert.ok(r.concentration.poolsAndLockersExcluded >= 0);
      assert.equal(r.decimals, 5);
    }
    assert.ok(Array.isArray(r.insiders.networks));
    assert.equal(typeof r.velocity.churnSuspected, "boolean");
  });

  it("evaluate_narrative_pulse scores a live token and compares against live trending tokens", async () => {
    const r = await evaluateNarrativePulse(deps, { query: BONK, chain: "solana" });
    assert.ok(r.found);
    if (!r.found) return;
    assert.ok(r.momentum.score >= 0 && r.momentum.score <= 100);
    assert.ok(["NONE", "LOW", "MEDIUM", "HIGH"].includes(r.copycat.risk));
    assert.ok(r.copycat.comparedAgainst > 0, "was compared against live trending/same-ticker tokens");
    assert.ok(["STRONG_NARRATIVE", "MODERATE_NARRATIVE", "WEAK_NARRATIVE", "LATE_COPYCAT"].includes(r.verdict));
    assert.ok(r.social.score >= 0 && r.social.score <= 100);
    assert.equal(typeof r.social.website.listed, "boolean");
  });

  it("copycat check recognises a famous original: $BONK itself is not a late copycat", async () => {
    const r = await evaluateNarrativePulse(deps, { query: BONK, chain: "solana" });
    assert.ok(r.found);
    if (r.found) assert.notEqual(r.copycat.risk, "HIGH");
  });
});

describe("paper trading loop on live market data (no funds, throwaway ledger)", { skip }, () => {
  it("buy -> monitor -> sell -> journal", { timeout: 180_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "dar-live-paper-"));
    tmp.push(dir);
    const ledger = new TradeLedger(join(dir, "trades.json"));
    const deps: ToolDeps = { dex: new DexScreenerClient(), security: new SecurityAuditor(), ledger, env: {} };

    // 1. the strict gate must block an old, established token (BONK is years old)
    const blocked: any = await simulateOrPrepareTrade(deps, { action: "buy", tokenAddress: BONK, sizeUsd: 25 });
    assert.equal(blocked.blocked, true);
    assert.ok(blocked.failed.some((f: string) => f.startsWith("age:")));
    assert.equal(ledger.list({ mode: "all" }).length, 0);

    // 2. an explicit, flagged experimental paper trade runs the full pipeline on live data
    const bought: any = await simulateOrPrepareTrade(deps, { action: "buy", tokenAddress: BONK, sizeUsd: 25, enforceEntryRules: false });
    t.diagnostic(`fill source: ${bought.fill.source}; notes: ${bought.fill.notes.join(" | ")}`);
    console.error(`[live paper] fill=${bought.fill.source} ref=${bought.fill.refPriceUsd} fill=${bought.fill.fillPriceUsd} fees=$${bought.fill.entryFeesUsd}`);
    assert.equal(bought.executed, true);
    assert.equal(bought.paperMode, true);
    assert.ok(bought.fill.fillPriceUsd > bought.fill.refPriceUsd, "buys fill above market (slippage + impact)");
    assert.ok(bought.fill.entryFeesUsd > 0);
    assert.equal(ledger.list({ status: "open" }).length, 1);

    // 3. monitor applies the guard against the live price; BONK will not hit TP/SL within seconds
    const mon: any = await simulateOrPrepareTrade(deps, { action: "monitor" });
    assert.equal(mon.checked, 1);
    assert.equal(mon.closed.length + mon.holding.length, 1);

    // 4. manual sell closes it with a real cost: the round trip pays slippage and fees
    const open = ledger.list({ status: "open" });
    if (open.length) {
      const sold: any = await simulateOrPrepareTrade(deps, { action: "sell", positionId: open[0]!.id });
      assert.equal(sold.executed, true);
      assert.ok(sold.fill.fillPriceUsd < sold.fill.refPriceUsd, "sells fill below market");
    }
    const closed = ledger.list({ status: "closed" })[0]!;
    assert.ok(closed.exit!.pnlUsd < 1 && closed.exit!.pnlPct > -20, `round trip PnL is small: ${closed.exit!.pnlPct}%`);

    // 5. the journal reads it back
    const j: any = await analyzeTradeJournal(deps, { minSample: 1 });
    assert.equal(j.closedTrades, 1);
    assert.equal(j.ruleBypassedTrades, 1);
    assert.equal(typeof j.summary.winRatePct, "number");
    assert.equal(j.bestChain.chain, "solana");
  });

  it("live unsigned preparation never touches a wallet and respects the gate", async () => {
    const deps: ToolDeps = { dex: new DexScreenerClient(), security: new SecurityAuditor(), ledger: new TradeLedger(join(mkdtempSync(join(tmpdir(), "dar-live-prep-")), "t.json")), env: {} };
    const r: any = await simulateOrPrepareTrade(deps, { action: "buy", tokenAddress: BONK, paperMode: false, walletPublicKey: newKeypair().pubBase58 });
    assert.equal(r.executed, false);
    assert.ok(r.blocked || r.prepared);
    assert.equal(deps.ledger!.list({ mode: "all" }).length, 0);
  });
});
