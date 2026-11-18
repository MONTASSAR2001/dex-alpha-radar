/**
 * Guardrails for live auto-execution with a burner wallet. Everything is opt-in and
 * fail-closed: if any required setting is missing or invalid, nothing is signed.
 *
 *   SOLANA_BURNER_PRIVATE_KEY          secret key of a dedicated, funded-with-small-amounts wallet.
 *                                      Env only: it is never accepted as a tool parameter.
 *   DEX_ALPHA_ALLOW_LIVE_EXECUTION     must be "true": explicit opt-in to signing at all
 *   MAX_TRADE_USD                      hard cap per buy (required for auto-execution)
 *   DAILY_LOSS_LIMIT_USD               stops new auto buys once today's realised live losses reach it
 *   SOLANA_RPC_URL                     optional RPC (defaults to the public mainnet endpoint)
 */
import { DEFAULT_RPC_URL } from "./solana.js";

export interface LiveConfig {
  burnerKeyPresent: boolean;
  allowLive: boolean;
  maxTradeUsd?: number;
  dailyLossLimitUsd?: number;
  rpcUrl: string;
}

const positive = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export function readLiveConfig(env: NodeJS.ProcessEnv): LiveConfig {
  return {
    burnerKeyPresent: !!env.SOLANA_BURNER_PRIVATE_KEY?.trim(),
    allowLive: env.DEX_ALPHA_ALLOW_LIVE_EXECUTION === "true" || env.DEX_ALPHA_ALLOW_LIVE_EXECUTION === "1",
    maxTradeUsd: positive(env.MAX_TRADE_USD),
    dailyLossLimitUsd: positive(env.DAILY_LOSS_LIMIT_USD),
    rpcUrl: env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC_URL,
  };
}

/** Problems that forbid auto-execution (empty array = allowed). */
export function autoExecutionProblems(cfg: LiveConfig, side: "buy" | "sell", sizeUsd: number, realizedLossTodayUsd: number): string[] {
  const out: string[] = [];
  if (!cfg.allowLive) out.push("DEX_ALPHA_ALLOW_LIVE_EXECUTION=true is not set (explicit opt-in to signing)");
  if (!cfg.burnerKeyPresent) out.push("SOLANA_BURNER_PRIVATE_KEY is not set in the server environment");
  if (cfg.maxTradeUsd === undefined) out.push("MAX_TRADE_USD is not set to a positive number");
  if (cfg.dailyLossLimitUsd === undefined) out.push("DAILY_LOSS_LIMIT_USD is not set to a positive number");
  if (side === "buy") {
    if (cfg.maxTradeUsd !== undefined && sizeUsd > cfg.maxTradeUsd) out.push(`sizeUsd $${sizeUsd} exceeds MAX_TRADE_USD $${cfg.maxTradeUsd}`);
    if (cfg.dailyLossLimitUsd !== undefined && realizedLossTodayUsd >= cfg.dailyLossLimitUsd) {
      out.push(`today's realised live loss $${realizedLossTodayUsd.toFixed(2)} has reached DAILY_LOSS_LIMIT_USD $${cfg.dailyLossLimitUsd}`);
    }
  }
  return out;
}
