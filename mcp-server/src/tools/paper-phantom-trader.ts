/**
 * simulate_or_prepare_trade: paper trading by default, Phantom-ready unsigned swaps on request,
 * and optional guard-railed burner-wallet auto-execution.
 *
 * Safety model (read this before changing anything):
 *  - paperMode defaults to TRUE. Nothing touches a wallet unless paperMode is false.
 *  - Live mode never signs by itself. It returns an UNSIGNED Jupiter swap transaction for the
 *    user's wallet (Phantom) to review and sign.
 *  - Auto-execution needs ALL of: autoExecute=true on the call, DEX_ALPHA_ALLOW_LIVE_EXECUTION=true,
 *    SOLANA_BURNER_PRIVATE_KEY, MAX_TRADE_USD and DAILY_LOSS_LIMIT_USD in the server environment.
 *    The key is read from the environment only, never accepted as a parameter, never returned.
 *  - The strict entry rules are always enforced for live trades.
 */
import { looksLikeSolanaAddress, normalizeChain, tokenKey } from "../chains.js";
import { dexUrl } from "../dexscreener.js";
import { computeAlphaScore, pairAgeHours } from "../scoring.js";
import type { Catalysts, DexPair, SecurityReport } from "../types.js";
import { simulateBuyFill, simulateSellFill, getSolPriceUsd, feesUsd, LAMPORTS_PER_SOL, type Fill } from "../trading/fills.js";
import { autoExecutionProblems, readLiveConfig } from "../trading/guardrails.js";
import { evaluateEntryRules, evaluateGuard, ENTRY_RULES, GUARD, type EntryEvaluation } from "../trading/guard.js";
import { JupiterClient, WSOL_MINT } from "../trading/jupiter.js";
import { TradeLedger, ledgerDir, type ExitReason, type Position, type TradeMode } from "../trading/ledger.js";
import { createSigner, isValidPublicKey, redactSecrets, SolanaRpc, type Signer } from "../trading/solana.js";
import { DISCLAIMER, type ToolDeps } from "./index.js";
import { evaluateNarrativePulse } from "./narrative-pulse.js";
import { analyzeWhaleForensics } from "./whale-forensics.js";
import { join } from "node:path";

export const DEFAULT_SLIPPAGE_BPS = 200;
export const DEFAULT_PRIORITY_FEE_LAMPORTS = 500_000;
export const DEFAULT_SIZE_USD = 25;
const MAX_SIZE_USD = 100_000;

export type TradeAction = "buy" | "sell" | "monitor" | "positions";

export interface TradeParams {
  action: TradeAction;
  chain?: string;
  tokenAddress?: string;
  positionId?: string;
  sizeUsd?: number;
  /** Default true. */
  paperMode?: boolean;
  slippageBps?: number;
  priorityFeeLamports?: number;
  /** Paper only: false skips the entry gate (recorded as such). Live always enforces it. */
  enforceEntryRules?: boolean;
  /** Live: the wallet that will sign (Phantom public key). Defaults to the burner's key when configured. */
  walletPublicKey?: string;
  /** Live: sign and send with the burner key (needs the env guardrails). */
  autoExecute?: boolean;
  /** Live unsigned sell: percent of the wallet's balance to sell (default 100). */
  sellPercent?: number;
  /** positions / monitor: which ledger entries (default paper). */
  mode?: TradeMode | "all";
}

// ---------------------------------------------------------------------------
// dependency helpers (lazy defaults, cached on deps)
// ---------------------------------------------------------------------------

const env = (deps: ToolDeps) => deps.env ?? process.env;
const nowMs = (deps: ToolDeps) => (deps.now ?? Date.now)();
const iso = (deps: ToolDeps) => new Date(nowMs(deps)).toISOString();

export function getLedger(deps: ToolDeps): TradeLedger {
  return (deps.ledger ??= new TradeLedger(join(ledgerDir(env(deps)), "trades.json")));
}
function getJupiter(deps: ToolDeps): JupiterClient {
  return (deps.jupiter ??= new JupiterClient({ bases: env(deps).JUPITER_API_URL ? [env(deps).JUPITER_API_URL!] : undefined }));
}
function getRpc(deps: ToolDeps): SolanaRpc {
  return (deps.rpc ??= new SolanaRpc({ url: readLiveConfig(env(deps)).rpcUrl }));
}

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

function validateCommon(p: TradeParams) {
  const slippageBps = p.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const priorityFeeLamports = p.priorityFeeLamports ?? DEFAULT_PRIORITY_FEE_LAMPORTS;
  if (!Number.isFinite(slippageBps) || slippageBps < 1 || slippageBps > 2000) throw new Error("slippageBps must be between 1 and 2000");
  if (!Number.isFinite(priorityFeeLamports) || priorityFeeLamports < 0 || priorityFeeLamports > 100_000_000) throw new Error("priorityFeeLamports must be between 0 and 100000000");
  return { slippageBps, priorityFeeLamports };
}

// ---------------------------------------------------------------------------
// presentation
// ---------------------------------------------------------------------------

export function summarizePosition(pos: Position) {
  const livePnl = pos.status === "open" && pos.lastPriceUsd ? round((pos.lastPriceUsd / pos.entryPriceUsd - 1) * 100, 2) : undefined;
  return {
    id: pos.id,
    mode: pos.mode,
    status: pos.status,
    symbol: pos.symbol,
    chain: pos.chain,
    tokenAddress: pos.tokenAddress,
    url: pos.url,
    openedAt: pos.openedAt,
    sizeUsd: pos.sizeUsd,
    entryPriceUsd: pos.entryPriceUsd,
    entryRefPriceUsd: pos.entryRefPriceUsd,
    tokenQty: pos.tokenQty,
    fillSource: pos.fillSource,
    pnlPct: pos.exit ? round(pos.exit.pnlPct, 2) : livePnl,
    pnlUsd: pos.exit ? round(pos.exit.pnlUsd, 2) : undefined,
    highWaterPct: round(pos.highWaterPct, 2),
    lowWaterPct: round(pos.lowWaterPct, 2),
    stopPct: pos.breakEvenArmed ? GUARD.breakEvenStopPct : GUARD.stopLossPct,
    breakEvenArmed: pos.breakEvenArmed,
    lastPriceUsd: pos.lastPriceUsd,
    lastCheckedAt: pos.lastCheckedAt,
    exit: pos.exit ? { at: pos.exit.at, reason: pos.exit.reason, priceUsd: pos.exit.priceUsd } : undefined,
    signature: pos.signature,
    confirmed: pos.confirmed,
    entry: pos.entry,
  };
}

const GUARD_SUMMARY = {
  entryRules: { maxAgeMinutes: ENTRY_RULES.maxAgeMinutes, security: ENTRY_RULES.requiredSecurity, minAlphaScore: ENTRY_RULES.minAlphaScore, forensics: "CLEAN_DISTRIBUTION", copycat: "NONE or LOW" },
  exits: {
    takeProfitPct: GUARD.takeProfitPct,
    stopLossPct: GUARD.stopLossPct,
    breakEvenAtGainPct: GUARD.breakEvenTriggerPct,
    emergencyIfLiquidityDropsPct: GUARD.emergencyLiquidityDropPct,
  },
};

// ---------------------------------------------------------------------------
// closing a position (shared by manual sells, the guard and the monitor)
// ---------------------------------------------------------------------------

function closeInLedger(deps: ToolDeps, pos: Position, fill: Fill, reason: ExitReason, exitFeesUsd: number, signature?: string): Position {
  const proceeds = pos.tokenQty * fill.fillPriceUsd;
  const costBasis = pos.sizeUsd + pos.entryFeesUsd;
  const pnlUsd = proceeds - exitFeesUsd - costBasis;
  const closed = getLedger(deps).update(pos.id, (p) => {
    p.status = "closed";
    p.exit = { at: iso(deps), priceUsd: fill.fillPriceUsd, refPriceUsd: fill.refPriceUsd, reason, feesUsd: exitFeesUsd, pnlUsd, pnlPct: (pnlUsd / costBasis) * 100, signature, fillSource: fill.source };
  });
  return closed ?? pos;
}

async function solPriceOrUndefined(deps: ToolDeps, chain: string): Promise<number | undefined> {
  if (chain !== "solana") return undefined;
  try {
    return await getSolPriceUsd(deps.dex, deps.jupiter ?? getJupiter(deps));
  } catch {
    return undefined;
  }
}

async function decimalsFor(deps: ToolDeps, chain: string, mint: string, known?: number): Promise<number | undefined> {
  if (known !== undefined || chain !== "solana") return known;
  try {
    return await getRpc(deps).getTokenDecimals(mint);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// buy
// ---------------------------------------------------------------------------

async function bestPair(deps: ToolDeps, chain: string, address: string): Promise<DexPair> {
  const pairs = await deps.dex.getTokenPairs(chain, [address]);
  const best = pairs.filter((p) => tokenKey(p.chainId, p.baseToken.address) === tokenKey(chain, address)).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!best) throw new Error(`No DexScreener pair found for ${address} on ${chain}`);
  return best;
}

interface EntryAnalysis {
  pair: DexPair;
  security: SecurityReport;
  alphaScore: number;
  ageMinutes: number | null;
  forensicsVerdict: string;
  holderSafetyScore: number | null;
  decimals?: number;
  copycatRisk: string;
  narrativeVerdict?: string;
  rules: EntryEvaluation;
  unavailable: string[];
}

async function analyzeEntry(deps: ToolDeps, chain: string, address: string): Promise<EntryAnalysis> {
  const pair = await bestPair(deps, chain, address);
  const unavailable: string[] = [];
  const [security, forensics, narrative] = await Promise.all([
    deps.security.audit(chain, address, { deep: true }),
    analyzeWhaleForensics(deps, { address, chain }).catch((e) => (unavailable.push(`forensics: ${e instanceof Error ? e.message : String(e)}`), undefined)),
    evaluateNarrativePulse(deps, { query: address, chain }).catch((e) => (unavailable.push(`narrative: ${e instanceof Error ? e.message : String(e)}`), undefined)),
  ]);
  const catalysts: Catalysts = narrative?.found ? { boosted: narrative.catalysts.boosted, cto: narrative.catalysts.cto } : { boosted: (pair.boosts?.active ?? 0) > 0, cto: false };
  const alpha = computeAlphaScore(pair, catalysts, security, nowMs(deps));
  const age = pairAgeHours(pair, nowMs(deps));
  const ageMinutes = age === undefined ? null : round(age * 60, 1);
  const forensicsVerdict = forensics?.verdict ?? "INSUFFICIENT_DATA";
  const copycatRisk = narrative?.found ? narrative.copycat.risk : "UNKNOWN";
  const rules = evaluateEntryRules({ ageMinutes, security: security.status, alphaScore: alpha.alphaScore, forensicsVerdict, copycatRisk });
  return {
    pair,
    security,
    alphaScore: alpha.alphaScore,
    ageMinutes,
    forensicsVerdict,
    holderSafetyScore: forensics?.holderSafetyScore ?? null,
    decimals: forensics?.decimals,
    copycatRisk,
    narrativeVerdict: narrative?.found ? narrative.verdict : undefined,
    rules,
    unavailable,
  };
}

async function buy(deps: ToolDeps, p: TradeParams) {
  const chain = normalizeChain(p.chain ?? "solana");
  const paper = p.paperMode ?? true;
  const address = (p.tokenAddress ?? "").trim();
  if (!address) throw new Error("tokenAddress is required for action=buy");
  const sizeUsd = p.sizeUsd ?? DEFAULT_SIZE_USD;
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || sizeUsd > MAX_SIZE_USD) throw new Error(`sizeUsd must be between 0 and ${MAX_SIZE_USD}`);
  const { slippageBps, priorityFeeLamports } = validateCommon(p);
  if (!paper && chain !== "solana") throw new Error("Live (Phantom/Jupiter) trades are Solana-only. Use paperMode for other chains.");
  if (!paper && p.enforceEntryRules === false) throw new Error("enforceEntryRules cannot be disabled for live trades");
  if (chain === "solana" && !looksLikeSolanaAddress(address)) throw new Error("tokenAddress is not a valid Solana mint");

  const live = readLiveConfig(env(deps));
  if (!paper && live.maxTradeUsd !== undefined && sizeUsd > live.maxTradeUsd) {
    throw new Error(`sizeUsd $${sizeUsd} exceeds MAX_TRADE_USD $${live.maxTradeUsd}`);
  }

  const a = await analyzeEntry(deps, chain, address);
  const enforce = paper ? (p.enforceEntryRules ?? true) : true;
  const context = {
    symbol: a.pair.baseToken.symbol,
    ageMinutes: a.ageMinutes,
    alphaScore: a.alphaScore,
    security: a.security.status,
    forensics: a.forensicsVerdict,
    holderSafetyScore: a.holderSafetyScore,
    copycatRisk: a.copycatRisk,
    narrativeVerdict: a.narrativeVerdict,
  };
  if (enforce && !a.rules.passed) {
    return {
      executed: false,
      blocked: true,
      paperMode: paper,
      reason: "Entry rules not met: no trade was opened",
      failed: a.rules.failed,
      checks: a.rules.checks,
      context,
      unavailable: a.unavailable,
      rules: GUARD_SUMMARY.entryRules,
      hint: paper ? "Paper mode only: pass enforceEntryRules=false to record an experimental trade (it is flagged as rule-bypassing in the journal)." : undefined,
      disclaimer: DISCLAIMER,
    };
  }

  const warnings: string[] = [];
  if (!a.rules.passed) warnings.push(`Entry rules were bypassed (${a.rules.failed.join("; ")}). This trade is flagged as experimental.`);
  if (sizeUsd > (a.pair.liquidity?.usd ?? 0) * 0.05) warnings.push(`Trade size is over 5% of pool liquidity ($${Math.round(a.pair.liquidity?.usd ?? 0)}): expect heavy price impact`);
  warnings.push(...a.unavailable.map((u) => `Unavailable: ${u}`));

  const jupiter = chain === "solana" ? getJupiter(deps) : undefined;
  const solPriceUsd = await solPriceOrUndefined(deps, chain);
  const decimals = await decimalsFor(deps, chain, address, a.decimals);

  return paper
    ? paperBuy(deps, { chain, a, sizeUsd, slippageBps, priorityFeeLamports, jupiter, solPriceUsd, decimals, context, rulesPassed: a.rules.passed, enforce, warnings })
    : liveBuy(deps, { chain, a, sizeUsd, slippageBps, priorityFeeLamports, jupiter: jupiter!, solPriceUsd, decimals, p, context, warnings });
}

interface BuyCtx {
  chain: string;
  a: EntryAnalysis;
  sizeUsd: number;
  slippageBps: number;
  priorityFeeLamports: number;
  solPriceUsd?: number;
  decimals?: number;
  context: Record<string, unknown>;
  warnings: string[];
}

async function paperBuy(deps: ToolDeps, c: BuyCtx & { jupiter?: JupiterClient; rulesPassed: boolean; enforce: boolean }) {
  const fill = await simulateBuyFill({ jupiter: c.jupiter, pair: c.a.pair, slippageBps: c.slippageBps, decimals: c.decimals, solPriceUsd: c.solPriceUsd }, c.sizeUsd);
  const entryFees = c.solPriceUsd ? feesUsd(c.priorityFeeLamports, c.solPriceUsd) : 0;
  const tokenQty = c.sizeUsd / fill.fillPriceUsd;
  const pos = getLedger(deps).add({
    mode: "paper",
    status: "open",
    chain: c.chain,
    tokenAddress: c.a.pair.baseToken.address,
    symbol: c.a.pair.baseToken.symbol,
    name: c.a.pair.baseToken.name,
    pairAddress: c.a.pair.pairAddress,
    url: dexUrl(c.a.pair),
    openedAt: iso(deps),
    sizeUsd: c.sizeUsd,
    entryFeesUsd: entryFees,
    tokenQty,
    rawQty: c.decimals !== undefined ? String(BigInt(Math.floor(tokenQty * 10 ** c.decimals))) : undefined,
    decimals: c.decimals,
    entryRefPriceUsd: fill.refPriceUsd,
    entryPriceUsd: fill.fillPriceUsd,
    slippageBps: c.slippageBps,
    priorityFeeLamports: c.priorityFeeLamports,
    fillSource: fill.source,
    entryLiquidityUsd: c.a.pair.liquidity?.usd ?? 0,
    entry: {
      ageMinutes: c.a.ageMinutes,
      alphaScore: c.a.alphaScore,
      security: c.a.security.status,
      forensics: c.a.forensicsVerdict,
      holderSafetyScore: c.a.holderSafetyScore,
      copycatRisk: c.a.copycatRisk,
      narrativeVerdict: c.a.narrativeVerdict,
      rulesEnforced: c.enforce,
      rulesPassed: c.rulesPassed,
    },
    highWaterPct: 0,
    lowWaterPct: 0,
    breakEvenArmed: false,
    lastPriceUsd: fill.refPriceUsd,
    lastLiquidityUsd: c.a.pair.liquidity?.usd,
    lastCheckedAt: iso(deps),
  });
  return {
    executed: true,
    paperMode: true,
    action: "buy",
    position: summarizePosition(pos),
    fill: {
      refPriceUsd: fill.refPriceUsd,
      fillPriceUsd: fill.fillPriceUsd,
      slippageBps: c.slippageBps,
      source: fill.source,
      notes: fill.notes,
      entryFeesUsd: round(entryFees, 4),
      effectiveSlippageVsMarketPct: round((fill.fillPriceUsd / fill.refPriceUsd - 1) * 100, 2),
    },
    context: c.context,
    guard: GUARD_SUMMARY.exits,
    warnings: c.warnings,
    next: "Call action=monitor (or let the server's background monitor run) to apply the stop-loss, break-even, take-profit and liquidity guards.",
    note: "SIMULATION: no real funds moved. Fills include slippage and fees, but real markets can be worse (failed transactions, rugs that freeze selling).",
    ledger: getLedger(deps).path,
    disclaimer: DISCLAIMER,
  };
}

// ----- live -----

function resolveSigner(deps: ToolDeps): Signer | undefined {
  const key = env(deps).SOLANA_BURNER_PRIVATE_KEY;
  if (!key?.trim()) return undefined;
  return createSigner(key);
}

function instructions() {
  return [
    "Review the swap: input SOL, output the token, and the minimum received (otherAmountThreshold).",
    "Sign it with your wallet. Phantom: use the transaction from a dApp/Solana tooling that supports base64 versioned transactions (signTransaction / signAndSendTransaction), or any wallet-adapter script.",
    "Submit before lastValidBlockHeight, otherwise rebuild the transaction.",
    "Unsigned trades are NOT recorded in the trade ledger.",
  ];
}

async function liveBuy(
  deps: ToolDeps,
  c: BuyCtx & { jupiter: JupiterClient; p: TradeParams },
) {
  const cfg = readLiveConfig(env(deps));
  const auto = c.p.autoExecute === true;
  let signer: Signer | undefined;
  try {
    signer = resolveSigner(deps);
  } catch (e) {
    throw new Error(redactSecrets(e instanceof Error ? e.message : String(e)));
  }
  const wallet = c.p.walletPublicKey?.trim() || signer?.publicKey;
  if (!wallet || !isValidPublicKey(wallet)) throw new Error("walletPublicKey (a valid Solana public key) is required for live trades, or configure SOLANA_BURNER_PRIVATE_KEY");
  if (signer && c.p.walletPublicKey && c.p.walletPublicKey.trim() !== signer.publicKey && auto) {
    throw new Error("walletPublicKey does not match the burner wallet; auto-execution only signs for the burner");
  }
  if (!c.solPriceUsd) throw new Error("Cannot price SOL right now; live swap not prepared");

  if (auto) {
    const problems = autoExecutionProblems(cfg, "buy", c.sizeUsd, getLedger(deps).dailyRealizedLossUsd("live", nowMs(deps)));
    if (problems.length) return { executed: false, blocked: true, paperMode: false, reason: "Auto-execution guardrails not satisfied: nothing was signed", problems, disclaimer: DISCLAIMER };
  }

  const lamports = BigInt(Math.max(1, Math.floor((c.sizeUsd / c.solPriceUsd) * LAMPORTS_PER_SOL)));
  const quote = await c.jupiter.quote({ inputMint: WSOL_MINT, outputMint: c.a.pair.baseToken.address, amount: lamports, slippageBps: c.slippageBps });
  const swap = await c.jupiter.swap({ quoteResponse: quote, userPublicKey: wallet, prioritizationFeeLamports: c.priorityFeeLamports });
  const tokensOut = c.decimals !== undefined ? Number(BigInt(quote.outAmount)) / 10 ** c.decimals : undefined;
  const minOut = c.decimals !== undefined ? Number(BigInt(quote.otherAmountThreshold)) / 10 ** c.decimals : undefined;
  const quoteInfo = {
    inputSol: Number(lamports) / LAMPORTS_PER_SOL,
    inputUsd: c.sizeUsd,
    expectedTokens: tokensOut,
    minimumTokens: minOut,
    priceImpactPct: quote.priceImpactPct,
    slippageBps: c.slippageBps,
    priorityFeeLamports: c.priorityFeeLamports,
    jupiterHost: c.jupiter.lastBase,
  };

  if (!auto) {
    return {
      executed: false,
      prepared: true,
      paperMode: false,
      action: "buy",
      wallet,
      unsignedTransactionBase64: swap.swapTransaction,
      lastValidBlockHeight: swap.lastValidBlockHeight,
      quote: quoteInfo,
      context: c.context,
      instructions: instructions(),
      warnings: c.warnings,
      note: "Nothing was signed or sent. You are in control of the wallet.",
      disclaimer: DISCLAIMER,
    };
  }

  // ---- guard-railed auto-execution with the burner key ----
  if (!signer) throw new Error("SOLANA_BURNER_PRIVATE_KEY is required for autoExecute");
  const rpc = getRpc(deps);
  const { signedBase64, signature: localSig } = signer.signTransaction(swap.swapTransaction);
  const sim = await rpc.simulate(signedBase64);
  if (sim.err) {
    return { executed: false, blocked: true, paperMode: false, reason: "Transaction simulation failed: nothing was sent", simulationError: sim.err, logs: sim.logs.slice(-6), disclaimer: DISCLAIMER };
  }
  const signature = await rpc.send(signedBase64);
  const conf = await rpc.confirm(signature);
  if (conf.error) return { executed: false, failed: true, paperMode: false, signature, reason: "Transaction failed on-chain", error: conf.error, disclaimer: DISCLAIMER };

  const effectivePrice = tokensOut ? c.sizeUsd / tokensOut : Number(c.a.pair.priceUsd);
  const pos = getLedger(deps).add({
    mode: "live",
    status: "open",
    chain: "solana",
    tokenAddress: c.a.pair.baseToken.address,
    symbol: c.a.pair.baseToken.symbol,
    name: c.a.pair.baseToken.name,
    pairAddress: c.a.pair.pairAddress,
    url: dexUrl(c.a.pair),
    openedAt: iso(deps),
    sizeUsd: c.sizeUsd,
    entryFeesUsd: feesUsd(c.priorityFeeLamports, c.solPriceUsd),
    tokenQty: tokensOut ?? c.sizeUsd / effectivePrice,
    rawQty: quote.outAmount,
    decimals: c.decimals,
    entryRefPriceUsd: Number(c.a.pair.priceUsd),
    entryPriceUsd: effectivePrice,
    slippageBps: c.slippageBps,
    priorityFeeLamports: c.priorityFeeLamports,
    fillSource: "jupiter",
    entryLiquidityUsd: c.a.pair.liquidity?.usd ?? 0,
    entry: {
      ageMinutes: c.a.ageMinutes,
      alphaScore: c.a.alphaScore,
      security: c.a.security.status,
      forensics: c.a.forensicsVerdict,
      holderSafetyScore: c.a.holderSafetyScore,
      copycatRisk: c.a.copycatRisk,
      narrativeVerdict: c.a.narrativeVerdict,
      rulesEnforced: true,
      rulesPassed: true,
    },
    highWaterPct: 0,
    lowWaterPct: 0,
    breakEvenArmed: false,
    signature,
    confirmed: conf.confirmed,
  });
  return {
    executed: true,
    paperMode: false,
    autoExecuted: true,
    action: "buy",
    signature,
    signatureMatchesLocal: signature === localSig,
    confirmed: conf.confirmed,
    position: summarizePosition(pos),
    quote: quoteInfo,
    explorer: `https://solscan.io/tx/${signature}`,
    warnings: [...c.warnings, ...(conf.confirmed ? [] : ["Not confirmed within the timeout: check the signature on an explorer. The position is tracked as unconfirmed until it lands."])],
    note: "LIVE: real funds moved from the burner wallet. Entry price is derived from the Jupiter quote, not the final on-chain fill.",
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// sell
// ---------------------------------------------------------------------------

async function sell(deps: ToolDeps, p: TradeParams) {
  const paper = p.paperMode ?? true;
  const ledger = getLedger(deps);
  const { slippageBps, priorityFeeLamports } = validateCommon(p);

  if (paper) {
    const pos = findOpen(deps, p, "paper");
    const chain = pos.chain;
    const pair = await bestPairByAddress(deps, pos);
    const solPriceUsd = await solPriceOrUndefined(deps, chain);
    const fill = await simulateSellFill({ jupiter: chain === "solana" ? getJupiter(deps) : undefined, pair, slippageBps, decimals: pos.decimals, solPriceUsd }, pos.tokenQty);
    const exitFees = solPriceUsd ? feesUsd(priorityFeeLamports, solPriceUsd) : 0;
    const closed = closeInLedger(deps, pos, fill, "MANUAL", exitFees);
    return { executed: true, paperMode: true, action: "sell", position: summarizePosition(closed), fill: { refPriceUsd: fill.refPriceUsd, fillPriceUsd: fill.fillPriceUsd, source: fill.source, notes: fill.notes, exitFeesUsd: round(exitFees, 4) }, note: "SIMULATION: no real funds moved.", ledger: ledger.path, disclaimer: DISCLAIMER };
  }

  // ----- live sell -----
  const chain = normalizeChain(p.chain ?? "solana");
  if (chain !== "solana") throw new Error("Live trades are Solana-only");
  let tracked: Position | undefined;
  try {
    tracked = findOpen(deps, p, "live");
  } catch {
    tracked = undefined;
  }
  const mint = tracked?.tokenAddress ?? (p.tokenAddress ?? "").trim();
  if (!mint || !looksLikeSolanaAddress(mint)) throw new Error("tokenAddress (or a live positionId) is required");
  const auto = p.autoExecute === true;
  const signer = resolveSigner(deps);
  const wallet = p.walletPublicKey?.trim() || signer?.publicKey;
  if (!wallet || !isValidPublicKey(wallet)) throw new Error("walletPublicKey is required for a live sell");
  const pct = p.sellPercent ?? 100;
  if (!(pct > 0 && pct <= 100)) throw new Error("sellPercent must be in (0, 100]");
  if (tracked && auto && pct !== 100) throw new Error("Tracked live positions can only be sold 100% (partial exits are not tracked)");
  if (auto) {
    const problems = autoExecutionProblems(readLiveConfig(env(deps)), "sell", 0, 0);
    if (problems.length) return { executed: false, blocked: true, paperMode: false, reason: "Auto-execution guardrails not satisfied: nothing was signed", problems, disclaimer: DISCLAIMER };
    if (!signer || signer.publicKey !== wallet) throw new Error("Auto-execution only signs for the burner wallet");
  }

  const rpc = getRpc(deps);
  const bal = await rpc.getTokenBalanceRaw(wallet, mint);
  const rawAmount = (bal.raw * BigInt(Math.round(pct * 100))) / 10_000n;
  if (rawAmount <= 0n) throw new Error("The wallet holds none of this token");
  const jupiter = getJupiter(deps);
  const quote = await jupiter.quote({ inputMint: mint, outputMint: WSOL_MINT, amount: rawAmount, slippageBps });
  const swap = await jupiter.swap({ quoteResponse: quote, userPublicKey: wallet, prioritizationFeeLamports: priorityFeeLamports });
  const solOut = Number(BigInt(quote.outAmount)) / LAMPORTS_PER_SOL;
  const quoteInfo = { sellRaw: rawAmount.toString(), decimals: bal.decimals, expectedSol: solOut, minimumSol: Number(BigInt(quote.otherAmountThreshold)) / LAMPORTS_PER_SOL, priceImpactPct: quote.priceImpactPct, slippageBps, jupiterHost: jupiter.lastBase };

  if (!auto) {
    return { executed: false, prepared: true, paperMode: false, action: "sell", wallet, unsignedTransactionBase64: swap.swapTransaction, lastValidBlockHeight: swap.lastValidBlockHeight, quote: quoteInfo, instructions: instructions(), note: "Nothing was signed or sent.", disclaimer: DISCLAIMER };
  }
  return executeLiveSell(deps, { signer: signer!, swapTx: swap.swapTransaction, tracked, quoteInfo, solOut, slippageBps, priorityFeeLamports, reason: "MANUAL" });
}

async function executeLiveSell(
  deps: ToolDeps,
  a: { signer: Signer; swapTx: string; tracked?: Position; quoteInfo: Record<string, unknown>; solOut: number; slippageBps: number; priorityFeeLamports: number; reason: ExitReason },
) {
  const rpc = getRpc(deps);
  const { signedBase64 } = a.signer.signTransaction(a.swapTx);
  const sim = await rpc.simulate(signedBase64);
  if (sim.err) return { executed: false, blocked: true, paperMode: false, reason: "Transaction simulation failed: nothing was sent", simulationError: sim.err, logs: sim.logs.slice(-6), disclaimer: DISCLAIMER };
  const signature = await rpc.send(signedBase64);
  const conf = await rpc.confirm(signature);
  if (conf.error) return { executed: false, failed: true, paperMode: false, signature, reason: "Transaction failed on-chain", error: conf.error, disclaimer: DISCLAIMER };
  let closed: Position | undefined;
  if (a.tracked && conf.confirmed) {
    const solPrice = await solPriceOrUndefined(deps, "solana");
    const proceedsUsd = solPrice ? a.solOut * solPrice : a.tracked.sizeUsd;
    const fill: Fill = { fillPriceUsd: proceedsUsd / a.tracked.tokenQty, refPriceUsd: a.tracked.lastPriceUsd ?? a.tracked.entryRefPriceUsd, source: "jupiter", notes: ["Derived from the Jupiter quote"] };
    closed = closeInLedger(deps, a.tracked, fill, a.reason, solPrice ? feesUsd(a.priorityFeeLamports, solPrice) : 0, signature);
  }
  return {
    executed: true,
    paperMode: false,
    autoExecuted: true,
    action: "sell",
    signature,
    confirmed: conf.confirmed,
    explorer: `https://solscan.io/tx/${signature}`,
    position: closed ? summarizePosition(closed) : undefined,
    quote: a.quoteInfo,
    note: "LIVE: real funds moved from the burner wallet.",
    disclaimer: DISCLAIMER,
  };
}

function findOpen(deps: ToolDeps, p: TradeParams, mode: TradeMode): Position {
  const open = getLedger(deps).list({ status: "open", mode });
  const pos = p.positionId ? open.find((x) => x.id === p.positionId) : open.find((x) => p.tokenAddress && tokenKey(x.chain, x.tokenAddress) === tokenKey(normalizeChain(p.chain ?? x.chain), p.tokenAddress));
  if (!pos) throw new Error(`No open ${mode} position found${p.positionId ? ` with id ${p.positionId}` : p.tokenAddress ? ` for ${p.tokenAddress}` : ": pass positionId or tokenAddress"}`);
  return pos;
}

async function bestPairByAddress(deps: ToolDeps, pos: Position): Promise<DexPair> {
  const fresh = (await deps.dex.getPairs(pos.chain, [pos.pairAddress])).find((x) => x.pairAddress.toLowerCase() === pos.pairAddress.toLowerCase());
  return fresh ?? (await bestPair(deps, pos.chain, pos.tokenAddress));
}

// ---------------------------------------------------------------------------
// monitor (Trailing Profit Guard)
// ---------------------------------------------------------------------------

export interface MonitorOptions {
  mode?: TradeMode | "all";
  autoExecute?: boolean;
  slippageBps?: number;
  priorityFeeLamports?: number;
}

export async function monitorPositions(deps: ToolDeps, o: MonitorOptions = {}) {
  const ledger = getLedger(deps);
  const mode = o.mode ?? "paper";
  const slippageBps = o.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const open = ledger.list({ status: "open", mode });

  // Resolve unconfirmed live buys first.
  for (const pos of open.filter((x) => x.mode === "live" && x.confirmed === false && x.signature)) {
    try {
      const st = await getRpc(deps).signatureStatus(pos.signature!);
      if (st === "confirmed") ledger.update(pos.id, (x) => void (x.confirmed = true));
      if (st === "failed") {
        const fill: Fill = { fillPriceUsd: 0, refPriceUsd: pos.entryRefPriceUsd, source: "jupiter", notes: ["Transaction failed on-chain"] };
        closeInLedger(deps, pos, { ...fill, fillPriceUsd: pos.entryPriceUsd }, "MANUAL", 0, pos.signature);
        ledger.update(pos.id, (x) => {
          if (x.exit) {
            x.exit.pnlUsd = -x.entryFeesUsd;
            x.exit.pnlPct = (-x.entryFeesUsd / (x.sizeUsd + x.entryFeesUsd)) * 100;
          }
        });
      }
    } catch {
      /* try again next cycle */
    }
  }

  const tracked = ledger.list({ status: "open", mode }).filter((x) => !(x.mode === "live" && x.confirmed === false));
  const byChain = new Map<string, Position[]>();
  for (const x of tracked) byChain.set(x.chain, [...(byChain.get(x.chain) ?? []), x]);
  const prices = new Map<string, DexPair>();
  await Promise.all(
    [...byChain].map(async ([chain, list]) => {
      try {
        for (const pr of await deps.dex.getPairs(chain, list.map((x) => x.pairAddress))) prices.set(`${chain}:${pr.pairAddress.toLowerCase()}`, pr);
      } catch {
        /* positions without a price are reported below */
      }
    }),
  );

  const closed: ReturnType<typeof summarizePosition>[] = [];
  const signals: { positionId: string; symbol: string; reason: ExitReason; detail?: string; hint: string }[] = [];
  const holding: ReturnType<typeof summarizePosition>[] = [];
  const noPrice: string[] = [];

  for (const pos of tracked) {
    const pair = prices.get(`${pos.chain}:${pos.pairAddress.toLowerCase()}`);
    const px = Number(pair?.priceUsd);
    if (!pair || !(px > 0)) {
      noPrice.push(pos.id);
      continue;
    }
    const g = evaluateGuard(pos, { priceUsd: px, liquidityUsd: pair.liquidity?.usd });
    const updated = ledger.update(pos.id, (x) => {
      x.highWaterPct = g.highWaterPct;
      x.lowWaterPct = g.lowWaterPct;
      x.breakEvenArmed = g.breakEvenArmed;
      x.lastPriceUsd = px;
      x.lastLiquidityUsd = pair.liquidity?.usd;
      x.lastCheckedAt = iso(deps);
    })!;
    if (!g.exit) {
      holding.push(summarizePosition(updated));
      continue;
    }
    if (pos.mode === "paper") {
      const emergency = g.exit === "EMERGENCY_LIQUIDITY";
      const slip = emergency ? Math.min(2000, slippageBps * 2) : slippageBps; // panic exits slip more
      const solPriceUsd = await solPriceOrUndefined(deps, pos.chain);
      const fill = await simulateSellFill({ jupiter: pos.chain === "solana" ? getJupiter(deps) : undefined, pair, slippageBps: slip, decimals: pos.decimals, solPriceUsd }, pos.tokenQty);
      const exitFees = solPriceUsd ? feesUsd(o.priorityFeeLamports ?? pos.priorityFeeLamports, solPriceUsd) : 0;
      const done = closeInLedger(deps, updated, fill, g.exit, exitFees);
      closed.push({ ...summarizePosition(done) });
      continue;
    }
    // live position: execute only on an explicit autoExecute call, otherwise raise a signal.
    if (o.autoExecute) {
      try {
        const live = readLiveConfig(env(deps));
        const problems = autoExecutionProblems(live, "sell", 0, 0);
        const signer = resolveSigner(deps);
        if (problems.length || !signer) {
          signals.push({ positionId: pos.id, symbol: pos.symbol, reason: g.exit, detail: g.detail, hint: `Auto-exit blocked: ${problems.join("; ") || "no burner key"}` });
          continue;
        }
        const bal = await getRpc(deps).getTokenBalanceRaw(signer.publicKey, pos.tokenAddress);
        if (bal.raw <= 0n) throw new Error("burner wallet holds none of this token");
        const jupiter = getJupiter(deps);
        const q = await jupiter.quote({ inputMint: pos.tokenAddress, outputMint: WSOL_MINT, amount: bal.raw, slippageBps: g.exit === "EMERGENCY_LIQUIDITY" ? Math.min(2000, slippageBps * 2) : slippageBps });
        const sw = await jupiter.swap({ quoteResponse: q, userPublicKey: signer.publicKey, prioritizationFeeLamports: o.priorityFeeLamports ?? pos.priorityFeeLamports });
        const res = await executeLiveSell(deps, { signer, swapTx: sw.swapTransaction, tracked: updated, quoteInfo: { expectedSol: Number(BigInt(q.outAmount)) / LAMPORTS_PER_SOL }, solOut: Number(BigInt(q.outAmount)) / LAMPORTS_PER_SOL, slippageBps, priorityFeeLamports: pos.priorityFeeLamports, reason: g.exit });
        if ("position" in res && res.position) closed.push(res.position);
        else signals.push({ positionId: pos.id, symbol: pos.symbol, reason: g.exit, detail: g.detail, hint: "Auto-exit did not complete: " + JSON.stringify(res).slice(0, 200) });
      } catch (e) {
        signals.push({ positionId: pos.id, symbol: pos.symbol, reason: g.exit, detail: g.detail, hint: `Auto-exit failed: ${redactSecrets(e instanceof Error ? e.message : String(e))}` });
      }
    } else {
      signals.push({ positionId: pos.id, symbol: pos.symbol, reason: g.exit, detail: g.detail, hint: "Exit signal for a live position. Call action=sell with paperMode=false (and walletPublicKey or autoExecute) to exit." });
    }
  }

  return { checkedAt: iso(deps), mode, checked: tracked.length, closed, exitSignals: signals, holding, noPrice, guard: GUARD_SUMMARY.exits, note: "The guard sees prices only when it runs. A spike and reversal between two checks can be missed." };
}

/** Background guard for PAPER positions only: live positions are never auto-sold from the timer. */
export function startPaperMonitor(deps: ToolDeps, intervalMs: number, onError?: (e: unknown) => void): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      if (getLedger(deps).list({ status: "open", mode: "paper" }).length) await monitorPositions(deps, { mode: "paper" });
    } catch (e) {
      onError?.(e);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function simulateOrPrepareTrade(deps: ToolDeps, p: TradeParams) {
  try {
    switch (p.action) {
      case "buy":
        return await buy(deps, p);
      case "sell":
        return await sell(deps, p);
      case "monitor":
        return await monitorPositions(deps, { mode: p.mode ?? "paper", autoExecute: p.autoExecute, slippageBps: p.slippageBps, priorityFeeLamports: p.priorityFeeLamports });
      case "positions": {
        const mode = p.mode ?? "paper";
        const ledger = getLedger(deps);
        const open = ledger.list({ status: "open", mode });
        const recent = ledger.list({ status: "closed", mode }).slice(-20).reverse();
        return {
          mode,
          open: open.map(summarizePosition),
          recentClosed: recent.map(summarizePosition),
          ledger: ledger.path,
          rules: GUARD_SUMMARY,
          live: describeLiveReadiness(deps),
          disclaimer: DISCLAIMER,
        };
      }
      default:
        throw new Error(`Unknown action: ${String(p.action)}`);
    }
  } catch (e) {
    // Never leak a secret through an error message.
    if (e instanceof Error) e.message = redactSecrets(e.message);
    throw e;
  }
}

/** What the server environment allows, without revealing any secret. */
export function describeLiveReadiness(deps: ToolDeps) {
  const cfg = readLiveConfig(env(deps));
  const missing = autoExecutionProblems(cfg, "sell", 0, 0);
  return { autoExecutionReady: missing.length === 0, burnerKeyConfigured: cfg.burnerKeyPresent, maxTradeUsd: cfg.maxTradeUsd, dailyLossLimitUsd: cfg.dailyLossLimitUsd, missing };
}
