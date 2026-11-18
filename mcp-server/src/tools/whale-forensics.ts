/**
 * analyze_whale_forensics: holder distribution forensics.
 *
 * Evidence (nothing is invented):
 *  - Solana: RugCheck full report: top holders (pools/lockers excluded), `insiderNetworks`
 *    (wallet clusters linked by transfers / shared funding), `graphInsidersDetected`,
 *    creator balance, total holder count.
 *  - EVM: GoPlus holders (contracts excluded), creator/owner percent. GoPlus has no
 *    bundle graph, so EVM bundle detection is reported as INSUFFICIENT_DATA.
 *  - DexScreener: transaction velocity (buys vs holder count, launch age).
 *
 * Fail-closed: no holder data => INSUFFICIENT_DATA and a null score, never CLEAN.
 */
import { looksLikeSolanaAddress, normalizeChain } from "../chains.js";
import { dexUrl } from "../dexscreener.js";
import { pairAgeHours } from "../scoring.js";
import { nonPoolHolders, type GoPlusTokenSecurity, type RugCheckReport } from "../security.js";
import type { DexPair } from "../types.js";
import { DISCLAIMER, type ToolDeps } from "./index.js";

export type ForensicsVerdict = "BUNDLE_DETECTED" | "CLEAN_DISTRIBUTION" | "INSUFFICIENT_DATA";

/** Any one of these marks the launch as bundled / insider-controlled. */
export const BUNDLE_THRESHOLDS = {
  /** % of supply still held by insider-flagged holders or insider networks. */
  insiderHoldingPct: 10,
  /** Number of distinct insider wallet networks. */
  networks: 3,
  /** Wallets in RugCheck's insider graph. */
  graphInsiders: 15,
  /** % of supply that passed through insider networks at launch. */
  distributedPct: 20,
} as const;

/** buys(24h) per holder above this (with enough volume) suggests a few wallets churning. */
export const CHURN_BUYS_PER_HOLDER = 8;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const lerp = (x: number, a: number, b: number, c: number, d: number) => c + ((clamp(x, a, b) - a) / (b - a)) * (d - c);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ForensicsInput {
  chain: string;
  address: string;
  report?: RugCheckReport;
  goplus?: GoPlusTokenSecurity;
  pair?: DexPair;
  now?: number;
}

export interface InsiderNetworkView {
  id?: string;
  type?: string;
  wallets?: number;
  activeWallets?: number;
  /** % of total supply these wallets hold now. */
  holdingPct?: number;
  /** % of total supply that moved through the network (launch distribution). */
  distributedPct?: number;
}

export interface ForensicsAnalysis {
  chain: string;
  address: string;
  verdict: ForensicsVerdict;
  /** 0-100 (100 = healthiest). Null when there is no holder data. */
  holderSafetyScore: number | null;
  band: "HEALTHY" | "CAUTION" | "HIGH_RISK" | "UNKNOWN";
  scoreBasis: "full" | "concentration-only" | "none";
  concentration: {
    top1Pct?: number;
    top5Pct?: number;
    top10Pct?: number;
    creatorPct?: number;
    walletsAnalyzed: number;
    poolsAndLockersExcluded: number;
    totalHolders?: number;
  };
  insiders: {
    flaggedHolderPct?: number;
    networks: InsiderNetworkView[];
    networkHoldingPct?: number;
    networkDistributedPct?: number;
    graphInsidersDetected?: number;
  };
  velocity: {
    ageMinutes?: number;
    buysM5?: number;
    buysH1?: number;
    buysH24?: number;
    buysPerHolder24h?: number;
    churnSuspected: boolean;
  };
  topHolders: { owner?: string; pct: number; insider: boolean; isCreator: boolean }[];
  /** Why the verdict is what it is. */
  reasons: string[];
  warnings: string[];
  /** Decimals of the token when known (used by the trader). */
  decimals?: number;
}

/** Pure analysis: no I/O. */
export function analyzeHolderForensics(input: ForensicsInput): ForensicsAnalysis {
  const { chain, address, report, goplus, pair } = input;
  const now = input.now ?? Date.now();
  const reasons: string[] = [];
  const warnings: string[] = [];
  const isSolana = chain === "solana";

  // ----- holders -----
  type H = { owner?: string; pct: number; insider: boolean; isCreator: boolean };
  let holders: H[] = [];
  let excluded = 0;
  let totalHolders: number | undefined;
  let creatorPct: number | undefined;
  let decimals: number | undefined;
  const supply = report?.token?.supply;

  if (isSolana && report) {
    const np = nonPoolHolders(report);
    holders = np.holders.map((h) => ({ owner: h.owner ?? h.address, pct: h.pct, insider: h.insider, isCreator: h.isCreator }));
    excluded = np.excluded;
    totalHolders = report.totalHolders ?? undefined;
    decimals = report.token?.decimals;
    if (supply && typeof report.creatorBalance === "number") creatorPct = r2((report.creatorBalance / supply) * 100);
    else {
      const c = holders.find((h) => h.isCreator);
      if (c) creatorPct = r2(c.pct);
    }
  } else if (!isSolana && goplus) {
    const wallets = (goplus.holders ?? []).filter((h) => !(h.is_contract === 1 || h.is_contract === "1"));
    holders = wallets
      .map((h) => ({ owner: h.address, pct: Number(h.percent ?? 0) * 100, insider: false, isCreator: false }))
      .filter((h) => Number.isFinite(h.pct))
      .sort((a, b) => b.pct - a.pct);
    excluded = (goplus.holders ?? []).length - wallets.length;
    totalHolders = goplus.holder_count ? Number(goplus.holder_count) : undefined;
    if (goplus.creator_percent !== undefined && goplus.creator_percent !== "") creatorPct = r2(Number(goplus.creator_percent) * 100);
  }

  const have = holders.length > 0;
  const sum = (n: number) => r2(holders.slice(0, n).reduce((a, h) => a + h.pct, 0));
  const concentration: ForensicsAnalysis["concentration"] = {
    top1Pct: have ? r2(holders[0]!.pct) : undefined,
    top5Pct: have ? sum(5) : undefined,
    top10Pct: have ? sum(10) : undefined,
    creatorPct,
    walletsAnalyzed: holders.length,
    poolsAndLockersExcluded: excluded,
    totalHolders,
  };

  // ----- insiders (Solana / RugCheck only) -----
  const networks: InsiderNetworkView[] = isSolana
    ? (report?.insiderNetworks ?? []).map((n) => ({
        id: n.id,
        type: n.type,
        wallets: n.size,
        activeWallets: n.activeAccounts,
        holdingPct: supply && typeof n.currentHolding === "number" ? r2((n.currentHolding / supply) * 100) : undefined,
        distributedPct: supply && typeof n.tokenAmount === "number" ? r2((n.tokenAmount / supply) * 100) : undefined,
      }))
    : [];
  const flaggedHolderPct = isSolana && have ? r2(holders.filter((h) => h.insider).reduce((a, h) => a + h.pct, 0)) : undefined;
  const sumOf = (k: "holdingPct" | "distributedPct") => (networks.length && networks.some((n) => n[k] !== undefined) ? r2(networks.reduce((a, n) => a + (n[k] ?? 0), 0)) : undefined);
  const networkHoldingPct = sumOf("holdingPct");
  const networkDistributedPct = sumOf("distributedPct");
  const graphInsiders = isSolana ? (report?.graphInsidersDetected ?? undefined) : undefined;
  const insiderHeldPct = Math.max(flaggedHolderPct ?? 0, networkHoldingPct ?? 0);

  // ----- DexScreener velocity -----
  const age = pair ? pairAgeHours(pair, now) : undefined;
  const buysH24 = pair?.txns?.h24?.buys;
  const buysPerHolder = buysH24 !== undefined && totalHolders && totalHolders > 0 ? r2(buysH24 / totalHolders) : undefined;
  const churn = buysPerHolder !== undefined && buysH24! >= 200 && buysPerHolder > CHURN_BUYS_PER_HOLDER;
  const velocity: ForensicsAnalysis["velocity"] = {
    ageMinutes: age === undefined ? undefined : Math.round(age * 60),
    buysM5: pair?.txns?.m5?.buys,
    buysH1: pair?.txns?.h1?.buys,
    buysH24,
    buysPerHolder24h: buysPerHolder,
    churnSuspected: churn,
  };

  // ----- verdict -----
  let verdict: ForensicsVerdict;
  if (!have && !(isSolana && report)) {
    verdict = "INSUFFICIENT_DATA";
    reasons.push(isSolana ? "RugCheck holder report unavailable: cannot rule out a bundled launch (fail-closed)" : "No holder data from GoPlus for this contract");
  } else if (!isSolana) {
    verdict = "INSUFFICIENT_DATA";
    reasons.push("Bundle/insider-network detection needs RugCheck's wallet graph and is only available on Solana; concentration is reported but no bundle verdict is possible");
  } else {
    const t = BUNDLE_THRESHOLDS;
    const hits: string[] = [];
    if (insiderHeldPct >= t.insiderHoldingPct) hits.push(`insiders still hold ${r1(insiderHeldPct)}% of supply (>= ${t.insiderHoldingPct}%)`);
    if (networks.length >= t.networks) hits.push(`${networks.length} insider wallet networks (>= ${t.networks})`);
    if ((graphInsiders ?? 0) >= t.graphInsiders) hits.push(`${graphInsiders} wallets in the insider graph (>= ${t.graphInsiders})`);
    if ((networkDistributedPct ?? 0) >= t.distributedPct) hits.push(`${r1(networkDistributedPct!)}% of supply was routed through insider networks at launch (>= ${t.distributedPct}%)`);
    if (hits.length) {
      verdict = "BUNDLE_DETECTED";
      reasons.push(...hits);
    } else {
      verdict = "CLEAN_DISTRIBUTION";
      reasons.push("No insider concentration above the bundle thresholds");
      if (networks.length || (graphInsiders ?? 0) > 0) reasons.push(`Minor insider activity noted: ${networks.length} network(s), ${graphInsiders ?? 0} graph wallet(s), ${r1(insiderHeldPct)}% held`);
    }
  }

  // ----- Holder Safety Score -----
  let score: number | null = null;
  let basis: ForensicsAnalysis["scoreBasis"] = "none";
  if (have || (isSolana && report)) {
    basis = isSolana ? "full" : "concentration-only";
    let s = 100;
    if (concentration.top10Pct !== undefined) s -= lerp(concentration.top10Pct, 20, 70, 0, 35);
    if (concentration.top1Pct !== undefined) s -= lerp(concentration.top1Pct, 5, 30, 0, 15);
    if (creatorPct !== undefined) s -= lerp(creatorPct, 5, 25, 0, 10);
    if (isSolana) {
      s -= lerp(insiderHeldPct, 0, 25, 0, 30);
      s -= lerp(networkDistributedPct ?? 0, 5, 30, 0, 10);
      s -= Math.min(8, networks.length * 2);
      s -= lerp(graphInsiders ?? 0, 0, 30, 0, 7);
    }
    if (churn) s -= 7;
    if (totalHolders !== undefined && age !== undefined && age > 0.5) s -= lerp(totalHolders, 20, 150, 6, 0);
    if (verdict === "BUNDLE_DETECTED") s = Math.min(s, 40);
    score = r1(clamp(s, 0, 100));
  }
  const band: ForensicsAnalysis["band"] = score === null ? "UNKNOWN" : score >= 70 ? "HEALTHY" : score >= 40 ? "CAUTION" : "HIGH_RISK";

  // ----- warnings -----
  if (concentration.top10Pct !== undefined && concentration.top10Pct >= 40) warnings.push(`High top-10 wallet concentration (${Math.round(concentration.top10Pct)}%)`);
  if (concentration.top1Pct !== undefined && concentration.top1Pct >= 15) warnings.push(`One wallet holds ${r1(concentration.top1Pct)}% of supply`);
  if (creatorPct !== undefined && creatorPct >= 5) warnings.push(`Creator wallet holds ${creatorPct}% of supply`);
  if (churn) warnings.push(`${buysPerHolder} buys per holder in 24h: a few wallets may be churning volume`);
  if (totalHolders !== undefined && totalHolders < 50 && (age ?? 0) > 0.5) warnings.push(`Only ${totalHolders} holders`);
  if (!isSolana) warnings.push("EVM bundle detection is not available; treat the concentration figures as the only evidence");

  return {
    chain,
    address,
    verdict,
    holderSafetyScore: score,
    band,
    scoreBasis: basis,
    concentration,
    insiders: { flaggedHolderPct, networks, networkHoldingPct, networkDistributedPct, graphInsidersDetected: graphInsiders },
    velocity,
    topHolders: holders.slice(0, 10).map((h) => ({ owner: h.owner, pct: r2(h.pct), insider: h.insider, isCreator: h.isCreator })),
    reasons,
    warnings,
    decimals,
  };
}

export interface WhaleForensicsParams {
  address: string;
  chain?: string;
}

/** Fetches RugCheck/GoPlus + DexScreener data and runs the analysis. */
export async function analyzeWhaleForensics(deps: ToolDeps, p: WhaleForensicsParams) {
  const chain = normalizeChain(p.chain ?? (looksLikeSolanaAddress(p.address) ? "solana" : "ethereum"));
  const address = p.address.trim();
  const now = (deps.now ?? Date.now)();

  const [report, goplus, pairs] = await Promise.all([
    chain === "solana" ? deps.security.rugReport(address) : Promise.resolve(undefined),
    chain !== "solana" ? deps.security.goplusEntry(chain, address) : Promise.resolve(undefined),
    deps.dex.getTokenPairs(chain, [address]).catch(() => [] as DexPair[]),
  ]);
  const pair = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const analysis = analyzeHolderForensics({ chain, address, report, goplus, pair, now });

  return {
    ...analysis,
    token: pair ? { symbol: pair.baseToken.symbol, name: pair.baseToken.name, url: dexUrl(pair), liquidityUsd: pair.liquidity?.usd } : undefined,
    dataSources: [
      chain === "solana" ? (report ? "rugcheck" : "rugcheck (unavailable)") : goplus ? "goplus" : "goplus (unavailable)",
      pair ? "dexscreener" : "dexscreener (no pair)",
    ],
    note: "Holder safety is a heuristic over public on-chain data, not proof of safety. Bundlers can use wallets no tool has linked yet.",
    disclaimer: DISCLAIMER,
  };
}
