#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DexScreenerClient } from "./dexscreener.js";
import { GeckoTerminalClient } from "./geckoterminal.js";
import { SecurityAuditor } from "./security.js";
import {
  auditTokenSecurity,
  compareWatchlist,
  detectFreshBirths,
  detectMomentumBreakouts,
  inspectToken,
  scanOpportunities,
  type ToolDeps,
} from "./tools/index.js";
import { evaluateNarrativePulse } from "./tools/narrative-pulse.js";
import { simulateOrPrepareTrade, startPaperMonitor } from "./tools/paper-phantom-trader.js";
import { analyzeTradeJournal } from "./tools/trade-journal.js";
import { analyzeWhaleForensics } from "./tools/whale-forensics.js";

export const SERVER_NAME = "dex-alpha-radar";
export const SERVER_VERSION = "1.2.0";

const chainParam = z
  .string()
  .min(1)
  .max(32)
  .describe('DexScreener chain id, e.g. "solana", "base", "ethereum", "bsc", "arbitrum", "polygon", or "all".');

type Payload = object;

async function run(fn: () => Promise<Payload>) {
  try {
    const out = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: `dex-alpha-radar error: ${message}` }] };
  }
}

/** Default dependencies; the same instance backs the tools and the background paper monitor (one ledger, one cache). */
const monitorDeps: ToolDeps = { dex: new DexScreenerClient(), security: new SecurityAuditor(), gecko: new GeckoTerminalClient() };

export function createServer(deps: ToolDeps = monitorDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

  server.registerTool(
    "scan_opportunities",
    {
      title: "Scan meme coin opportunities",
      description:
        "Aggregates DexScreener latest boosts, top boosts, latest profiles and community takeovers, batch-fetches live market data, filters by liquidity/age/chain, security-audits the strongest candidates (RugCheck for Solana, GoPlus for EVM) and returns them ranked by Alpha Score (0-100) with metrics and DexScreener URLs. Tokens with DANGER security are hidden unless includeRisky is true.",
      inputSchema: {
        chain: chainParam.default("all").optional(),
        minLiquidityUsd: z.number().min(0).default(15000).optional().describe("Minimum pool liquidity in USD (default 15000)."),
        maxAgeHours: z.number().positive().default(72).optional().describe("Maximum pair age in hours (default 72)."),
        includeRisky: z.boolean().default(false).optional().describe("Include tokens whose security verdict is DANGER (default false)."),
        limit: z.number().int().min(1).max(25).default(10).optional().describe("Max results (default 10)."),
        useBrowserTrending: z
          .boolean()
          .default(false)
          .optional()
          .describe(
            "Also read DexScreener's trending view with a local headless Chrome/Chromium (needs Chrome installed). Slower (up to ~40s); degrades gracefully to API sources if the browser is missing or DexScreener shows a bot check. See the `trending` field in the result.",
          ),
      },
      annotations,
    },
    (args) => run(() => scanOpportunities(deps, args)),
  );

  server.registerTool(
    "inspect_token",
    {
      title: "Inspect a token",
      description:
        "Deep-dive lookup by symbol, name or contract address across all DEX pools. Returns exact price, FDV, liquidity, 5m/1h/6h/24h price and volume, buy/sell counts, social links, pool list, security audit and Alpha Score. Warns when several tokens share a symbol (copycats).",
      inputSchema: {
        query: z.string().min(1).max(100).describe("Token symbol, name, or contract address (CA)."),
        chain: chainParam.optional().describe("Optionally restrict to one chain."),
      },
      annotations,
    },
    (args) => run(() => inspectToken(deps, args)),
  );

  server.registerTool(
    "audit_token_security",
    {
      title: "Audit token contract security",
      description:
        "Standalone deep contract audit. Solana mints use RugCheck (risk score, mint/freeze authority, holder concentration, flags). EVM contracts (ethereum, base, bsc, arbitrum, polygon) use GoPlus (honeypot, buy/sell tax, cannot-sell-all, owner balance control, open source). Fails closed: missing data is reported as UNVERIFIED, never SAFE.",
      inputSchema: {
        chain: chainParam.describe('Chain of the token, e.g. "solana", "base", "ethereum", "bsc", "arbitrum", "polygon".'),
        address: z.string().min(20).max(66).describe("Solana mint or EVM contract address."),
      },
      annotations,
    },
    (args) => run(() => auditTokenSecurity(deps, args)),
  );

  server.registerTool(
    "detect_momentum_breakouts",
    {
      title: "Detect momentum breakouts",
      description:
        "Finds tokens with sudden 5-minute volume surges (m5 volume x12 vs the 1h baseline) and buy-pressure spikes, before they top trending charts. Security-audits hits and ranks by breakout strength. Returns near-misses when nothing qualifies.",
      inputSchema: {
        chain: chainParam.default("all").optional(),
        minLiquidityUsd: z.number().min(0).default(10000).optional().describe("Minimum liquidity in USD (default 10000)."),
        maxAgeHours: z.number().positive().default(168).optional().describe("Maximum pair age in hours (default 168)."),
        minAcceleration: z.number().min(1).default(2).optional().describe("Required (m5 volume x 12) / h1 volume ratio (default 2)."),
        minBuyRatio: z.number().min(0.5).max(1).default(0.6).optional().describe("Required 5m buys/(buys+sells) (default 0.6)."),
        includeRisky: z.boolean().default(false).optional().describe("Include DANGER-rated tokens (default false)."),
        limit: z.number().int().min(1).max(25).default(10).optional().describe("Max results (default 10)."),
      },
      annotations,
    },
    (args) => run(() => detectMomentumBreakouts(deps, args)),
  );

  server.registerTool(
    "detect_fresh_births",
    {
      title: "Detect Minute-0 fresh births",
      description:
        "Catches meme coins in their first minutes (default 0-20 minutes old, including Minute 0-2 launches), freshest first. Hunts DexScreener latest profiles/boosts/takeovers + DexScreener search for the newest pairs + GeckoTerminal new_pools (solana, base, ethereum, bsc, ton, arbitrum), de-duplicates by chain+address, runs an instant RugCheck/GoPlus audit and scores Early Birth Velocity (5m buy/sell ratio, 5m volume vs liquidity, 5m price surge, socials, security). Returns exact ageSeconds/ageMinutes, pairCreatedAt, imageUrl, price, market cap, liquidity, 5m/1h volume and % change, 5m buys/sells, security verdict, and all direct links (dexscreenerUrl, tradeUrl for Pump.fun/Raydium/Jupiter/Uniswap/PancakeSwap, explorerUrl for Solscan/Basescan/Etherscan/BscScan, socials: twitter/telegram/websites). Brand-new tokens are extremely risky: UNVERIFIED means no audit data, never safe.",
      inputSchema: {
        maxAgeMinutes: z.number().min(1).max(180).default(20).optional().describe("Maximum pair age in minutes (default 20)."),
        chain: chainParam.default("all").optional(),
        minLiquidityUsd: z.number().min(0).default(0).optional().describe("Minimum liquidity in USD (default 0: nothing is hidden for being tiny)."),
        limit: z.number().int().min(1).max(100).default(30).optional().describe("Max results (default 30)."),
        includeRisky: z.boolean().default(false).optional().describe("Include DANGER-rated tokens (default false)."),
        securityTimeoutSeconds: z.number().min(0).max(60).default(12).optional().describe("How long to wait for RugCheck/GoPlus audits before answering (default 12). Unfinished audits are reported UNVERIFIED + auditPending and complete in the background."),
      },
      annotations,
    },
    (args) => run(() => detectFreshBirths(deps, args)),
  );

  server.registerTool(
    "compare_watchlist",
    {
      title: "Compare a watchlist",
      description:
        "Batch-fetches live metrics for up to 60 token addresses in minimal API calls (30 per request), audits security and returns a side-by-side ranking by Alpha Score. Solana addresses need no chain; EVM addresses without a chain are resolved automatically.",
      inputSchema: {
        tokens: z
          .array(z.object({ address: z.string().min(20).max(66), chain: chainParam.optional() }))
          .min(1)
          .max(60)
          .describe("Tokens to compare: contract addresses with optional chain."),
        defaultChain: chainParam.optional().describe("Chain applied to tokens that do not specify one."),
      },
      annotations,
    },
    (args) => run(() => compareWatchlist(deps, args)),
  );

  // ---- forensics, narrative, trading, journal ----

  server.registerTool(
    "analyze_whale_forensics",
    {
      title: "Analyze whale and bundle forensics",
      description:
        "Holder forensics for a token contract: top-holder concentration (liquidity pools, lockers and exchanges excluded), creator share, insider wallet networks and early-distribution patterns (RugCheck wallet graph on Solana; GoPlus holders on EVM) plus DexScreener transaction velocity. Returns BUNDLE_DETECTED, CLEAN_DISTRIBUTION or INSUFFICIENT_DATA (fail-closed) and a Holder Safety Score 0-100. EVM chains get concentration only; bundle detection is Solana-only.",
      inputSchema: {
        address: z.string().min(20).max(66).describe("Token mint (Solana) or contract address (EVM)."),
        chain: chainParam.optional().describe('Defaults to "solana" for base58 addresses.'),
      },
      annotations,
    },
    (args) => run(() => analyzeWhaleForensics(deps, args)),
  );

  server.registerTool(
    "evaluate_narrative_pulse",
    {
      title: "Evaluate narrative pulse",
      description:
        "Scores a token's narrative: market-attention momentum (0-100), copycat risk against DexScreener's current trending tokens and same-ticker pools (late copycats are flagged HIGH), and social presence (website, X, Telegram: format-checked links from the DexScreener listing, not independently verified accounts). Does not measure tweet or chat volume.",
      inputSchema: {
        query: z.string().min(1).max(100).describe("Token symbol, name, or contract address."),
        chain: chainParam.optional().describe("Optionally restrict to one chain."),
      },
      annotations,
    },
    (args) => run(() => evaluateNarrativePulse(deps, args)),
  );

  server.registerTool(
    "simulate_or_prepare_trade",
    {
      title: "Simulate or prepare a trade",
      description:
        "Paper-trades by default (paperMode=true): simulates fills with live DexScreener + Jupiter quotes, 2% slippage and Solana priority fees, and records positions in ~/.dex-alpha-radar/trades.json. Entry rules (age <= 5 min, SAFE security, Alpha >= 70, clean holder distribution, no copycat) and the Trailing Profit Guard (break-even at +50%, take profit +100%, stop loss -30%, emergency exit if liquidity falls > 20%) are enforced. actions: buy | sell | monitor | positions. With paperMode=false it returns an UNSIGNED Jupiter swap transaction for your wallet (Phantom) to sign; optional burner-wallet auto-execution needs autoExecute=true plus server-side env guardrails and never accepts a private key as a parameter.",
      inputSchema: {
        action: z.enum(["buy", "sell", "monitor", "positions"]).describe("buy opens a position, sell closes one, monitor applies the guard to open positions, positions lists the ledger."),
        chain: chainParam.optional().describe('Default "solana". Live trades are Solana-only.'),
        tokenAddress: z.string().min(20).max(66).optional().describe("Token mint/contract (buy; sell if no positionId)."),
        positionId: z.string().min(1).max(40).optional().describe("Ledger position id (sell)."),
        sizeUsd: z.number().positive().max(100000).optional().describe("USD to swap into the token (buy). Default 25."),
        paperMode: z.boolean().default(true).optional().describe("Default true: simulation only. false prepares a real swap."),
        slippageBps: z.number().int().min(1).max(2000).optional().describe("Slippage in basis points. Default 200 (2%)."),
        priorityFeeLamports: z.number().int().min(0).max(100000000).optional().describe("Solana priority fee in lamports. Default 500000."),
        enforceEntryRules: z.boolean().optional().describe("Paper only: false records an experimental trade that bypasses the entry gate (flagged in the journal). Ignored/forbidden for live trades."),
        walletPublicKey: z.string().min(32).max(44).optional().describe("Live: the Solana public key (Phantom) that will sign. Defaults to the burner wallet when configured."),
        autoExecute: z.boolean().default(false).optional().describe("Live: sign and send with the server's burner key. Requires DEX_ALPHA_ALLOW_LIVE_EXECUTION=true, SOLANA_BURNER_PRIVATE_KEY, MAX_TRADE_USD and DAILY_LOSS_LIMIT_USD in the server environment."),
        sellPercent: z.number().gt(0).max(100).optional().describe("Live unsigned sell: percent of the wallet balance (default 100)."),
        mode: z.enum(["paper", "live", "all"]).optional().describe("monitor/positions: which ledger entries (default paper)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(() => simulateOrPrepareTrade(deps, args)),
  );

  server.registerTool(
    "analyze_trade_journal",
    {
      title: "Analyze the trade journal",
      description:
        "Reads the local trade ledger and reports win rate, net and average PnL %, profit factor, the best-performing chain and launch-age window, exit-reason breakdown, and concrete threshold optimisations (Alpha minimum, entry age window, take-profit, stop-loss, break-even trigger) from in-sample replays. Needs a minimum sample (default 5 closed trades) before suggesting anything; suggestions are never applied automatically.",
      inputSchema: {
        mode: z.enum(["paper", "live", "all"]).optional().describe("Which trades (default paper)."),
        since: z.string().max(40).optional().describe("ISO date: only trades opened on or after it."),
        minSample: z.number().int().min(1).max(500).optional().describe("Minimum closed trades for a meaningful suggestion (default 5)."),
        onlyRuleCompliant: z.boolean().optional().describe("Exclude trades that bypassed the entry rules."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => analyzeTradeJournal(deps, args)),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  // Paper-position guard: checks open PAPER positions on a timer. Live positions are never auto-sold from here.
  const sec = Number(process.env.DEX_ALPHA_MONITOR_INTERVAL_SEC ?? 30);
  if (Number.isFinite(sec) && sec > 0) startPaperMonitor(monitorDeps, Math.max(5, sec) * 1000, (e) => console.error("[paper monitor]", e instanceof Error ? e.message : e));
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} v${SERVER_VERSION} MCP server running on stdio`);
}

// Only start when executed directly (not when imported by tests).
const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
