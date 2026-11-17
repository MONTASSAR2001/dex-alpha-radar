#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DexScreenerClient } from "./dexscreener.js";
import { SecurityAuditor } from "./security.js";
import {
  auditTokenSecurity,
  compareWatchlist,
  detectMomentumBreakouts,
  inspectToken,
  scanOpportunities,
  type ToolDeps,
} from "./tools.js";

export const SERVER_NAME = "dex-alpha-radar";
export const SERVER_VERSION = "1.0.0";

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

export function createServer(deps: ToolDeps = { dex: new DexScreenerClient(), security: new SecurityAuditor() }): McpServer {
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

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
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
