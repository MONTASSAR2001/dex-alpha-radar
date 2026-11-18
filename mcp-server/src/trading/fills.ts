/**
 * Fill simulation for paper trades.
 *
 * Preferred: a live Jupiter quote (real route, real price impact), then the configured
 * slippage is applied on top as a cost (buys fill higher, sells fill lower) so results are
 * conservative rather than optimistic. Fallback when Jupiter or the token's decimals are not
 * available (or for non-Solana chains): a constant-product impact model from pool liquidity,
 * also with slippage. Every fill reports which path produced it.
 */
import type { DexScreenerClient } from "../dexscreener.js";
import type { DexPair } from "../types.js";
import { JupiterClient, USDC_MINT, WSOL_MINT, type JupiterQuote } from "./jupiter.js";

export const BASE_FEE_LAMPORTS = 5_000;
export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface Fill {
  fillPriceUsd: number;
  refPriceUsd: number;
  source: "jupiter" | "model";
  /** Price impact beyond the quote, as a fraction, from the model path; Jupiter's own figure when quoted. */
  priceImpact?: number | string;
  notes: string[];
  quote?: JupiterQuote;
}

export function feesUsd(priorityFeeLamports: number, solPriceUsd: number): number {
  return ((BASE_FEE_LAMPORTS + priorityFeeLamports) / LAMPORTS_PER_SOL) * solPriceUsd;
}

/** SOL/USD from DexScreener's deepest WSOL pool, falling back to a Jupiter SOL->USDC quote. */
export async function getSolPriceUsd(dex: DexScreenerClient, jupiter?: JupiterClient): Promise<number> {
  try {
    const pairs = await dex.getTokenPairs("solana", [WSOL_MINT]);
    const best = pairs.filter((p) => p.baseToken.address === WSOL_MINT).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const px = Number(best?.priceUsd);
    if (px > 0) return px;
  } catch {
    /* fall through */
  }
  if (jupiter) {
    const q = await jupiter.quote({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amount: LAMPORTS_PER_SOL, slippageBps: 50 });
    const px = Number(q.outAmount) / 1e6;
    if (px > 0) return px;
  }
  throw new Error("Cannot determine the SOL price (DexScreener and Jupiter both unavailable)");
}

interface FillEnv {
  jupiter?: JupiterClient;
  pair: DexPair;
  slippageBps: number;
  decimals?: number;
  solPriceUsd?: number;
}

const refPrice = (pair: DexPair): number => {
  const p = Number(pair.priceUsd);
  if (!(p > 0)) throw new Error("DexScreener returned no usable priceUsd for this pair");
  return p;
};

/** Constant-product price impact for swapping `usd` against a pool with `liquidityUsd` in total. */
export function modelImpact(usd: number, liquidityUsd: number): number {
  const reserve = Math.max(liquidityUsd, 1) / 2;
  return usd / (reserve + usd);
}

export async function simulateBuyFill(env: FillEnv, usd: number): Promise<Fill> {
  const ref = refPrice(env.pair);
  const slip = env.slippageBps / 10_000;
  const notes: string[] = [];
  if (env.pair.chainId === "solana" && env.jupiter && env.decimals !== undefined && env.solPriceUsd) {
    try {
      const lamports = BigInt(Math.max(1, Math.floor((usd / env.solPriceUsd) * LAMPORTS_PER_SOL)));
      const quote = await env.jupiter.quote({ inputMint: WSOL_MINT, outputMint: env.pair.baseToken.address, amount: lamports, slippageBps: env.slippageBps });
      const tokensOut = Number(BigInt(quote.outAmount)) / 10 ** env.decimals;
      const quotePrice = usd / tokensOut;
      return { fillPriceUsd: quotePrice * (1 + slip), refPriceUsd: ref, source: "jupiter", priceImpact: quote.priceImpactPct, notes: [`Jupiter route via ${new URL(env.jupiter.lastBase ?? "https://jup").host}; ${env.slippageBps / 100}% slippage added`], quote };
    } catch (e) {
      notes.push(`Jupiter quote unavailable (${e instanceof Error ? e.message : String(e)}); used the liquidity model`);
    }
  } else if (env.pair.chainId === "solana") {
    notes.push(env.decimals === undefined ? "Token decimals unknown; used the liquidity model" : "Used the liquidity model (no Jupiter client)");
  } else {
    notes.push("Non-Solana chain: used the liquidity model (Jupiter is Solana-only)");
  }
  const impact = modelImpact(usd, env.pair.liquidity?.usd ?? 0);
  return { fillPriceUsd: ref * (1 + impact) * (1 + slip), refPriceUsd: ref, source: "model", priceImpact: impact, notes: [...notes, `Model impact ${(impact * 100).toFixed(2)}% + ${env.slippageBps / 100}% slippage`] };
}

export async function simulateSellFill(env: FillEnv, qty: number): Promise<Fill> {
  const ref = refPrice(env.pair);
  const slip = env.slippageBps / 10_000;
  const notes: string[] = [];
  if (env.pair.chainId === "solana" && env.jupiter && env.decimals !== undefined && env.solPriceUsd) {
    try {
      const rawIn = BigInt(Math.max(1, Math.floor(qty * 10 ** env.decimals)));
      const quote = await env.jupiter.quote({ inputMint: env.pair.baseToken.address, outputMint: WSOL_MINT, amount: rawIn, slippageBps: env.slippageBps });
      const proceeds = (Number(BigInt(quote.outAmount)) / LAMPORTS_PER_SOL) * env.solPriceUsd;
      return { fillPriceUsd: (proceeds / qty) * (1 - slip), refPriceUsd: ref, source: "jupiter", priceImpact: quote.priceImpactPct, notes: [`Jupiter sell route; ${env.slippageBps / 100}% slippage deducted`], quote };
    } catch (e) {
      notes.push(`Jupiter sell quote unavailable (${e instanceof Error ? e.message : String(e)}); used the liquidity model`);
    }
  }
  const value = qty * ref;
  const impact = modelImpact(value, env.pair.liquidity?.usd ?? 0);
  return { fillPriceUsd: ref * (1 - impact) * (1 - slip), refPriceUsd: ref, source: "model", priceImpact: impact, notes: [...notes, `Model impact ${(impact * 100).toFixed(2)}% + ${env.slippageBps / 100}% slippage`] };
}
