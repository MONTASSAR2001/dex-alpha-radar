#!/usr/bin/env node
/**
 * Live end-to-end demo: drives all five MCP tools through the real stdio launcher
 * (the exact path an agent uses) against live DexScreener / RugCheck / GoPlus data.
 *
 *   node scripts/demo.mjs [--trending] [--json]
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = (p) => import(pathToFileURL(join(root, "mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm", p)).href);
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");

const args = new Set(process.argv.slice(2));
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "scripts/mcp-launch.mjs")], stderr: "pipe" });
const client = new Client({ name: "dex-alpha-radar-demo", version: "1.0.0" });
await client.connect(transport);

const timings = [];
async function call(name, params) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: params }, undefined, { timeout: 180_000 });
  const text = res.content[0].text;
  timings.push([name, params.chain ?? params.query ?? "", Date.now() - t0, res.isError ? "ERROR" : "ok"]);
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

// ---------- formatting ----------
const usd = (n) => (n === undefined || n === null ? "n/a" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);
const pct = (n) => (n === undefined || n === null ? "n/a" : `${n > 0 ? "+" : ""}${n}%`);
const ratio = (n) => (n === undefined || n === null ? "n/a" : `${Math.round(n * 100)}%`);
const short = (a) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const age = (h) => (h === undefined ? "n/a" : h < 48 ? `${h}h` : `${(h / 24).toFixed(1)}d`);

function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => `| ${r.map((c, i) => String(c).padEnd(w[i])).join(" | ")} |`;
  return [line(headers), `|${w.map((n) => "-".repeat(n + 2)).join("|")}|`, ...rows.map(line)].join("\n");
}

const resultRows = (list) =>
  list.map((x) => [x.rank, `$${x.symbol}`, x.chain, x.priceUsd ?? "n/a", usd(x.liquidityUsd), usd(x.fdv), age(x.ageHours), `${pct(x.priceChangePct?.m5)} / ${pct(x.priceChangePct?.h1)} / ${pct(x.priceChangePct?.h24)}`, `${ratio(x.buyRatio.m5)} / ${ratio(x.buyRatio.h1)}`, x.tradeQuality.avgTradeUsd1h === undefined ? "n/a" : `$${x.tradeQuality.avgTradeUsd1h}`, x.alphaScore, x.security.status]);
const RESULT_HEADERS = ["#", "Token", "Chain", "Price (USD)", "Liq", "FDV", "Age", "5m / 1h / 24h", "Buy% 5m/1h", "Avg trade", "Alpha", "Security"];

function warningsOf(list) {
  const out = list.filter((x) => x.warnings.length).map((x) => `  - $${x.symbol}: ${x.warnings.slice(0, 3).join(" · ")}`);
  return out.length ? `Warnings:\n${out.join("\n")}` : "Warnings: none";
}

function section(title) {
  console.log(`\n${"=".repeat(8)} ${title} ${"=".repeat(Math.max(3, 96 - title.length))}`);
}

let failed = 0;
async function step(title, fn) {
  section(title);
  try {
    await fn();
  } catch (e) {
    failed++;
    console.log(`FAILED: ${e.message}`);
  }
}

try {
  const { tools } = await client.listTools();
  section("MCP server (via scripts/mcp-launch.mjs, stdio)");
  console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

  let sol, base;
  await step(`1. scan_opportunities  chain=solana${args.has("--trending") ? "  +browser trending" : ""}`, async () => {
    sol = await call("scan_opportunities", { chain: "solana", limit: 5, minLiquidityUsd: 10_000, maxAgeHours: 168, useBrowserTrending: args.has("--trending") });
    console.log(`candidates=${sol.stats.candidates} pairs=${sol.stats.pairsFetched} passedFilters=${sol.stats.passedFilters} audited=${sol.stats.audited} returned=${sol.stats.returned}`);
    if (sol.trending) console.log(`browser trending: ${sol.trending.status} (${sol.trending.pairsFound} pairs, ${sol.trending.tokensAdded} tokens added): ${sol.trending.message}`);
    if (sol.warnings.length) console.log(`discovery warnings: ${sol.warnings.join(" | ")}`);
    console.log(table(RESULT_HEADERS, resultRows(sol.results)));
    console.log(warningsOf(sol.results));
    if (args.has("--json")) console.log(JSON.stringify(sol.results[0], null, 2));
  });

  await step("2. scan_opportunities  chain=base", async () => {
    base = await call("scan_opportunities", { chain: "base", limit: 5, minLiquidityUsd: 10_000, maxAgeHours: 168 });
    console.log(`candidates=${base.stats.candidates} pairs=${base.stats.pairsFetched} passedFilters=${base.stats.passedFilters} audited=${base.stats.audited} returned=${base.stats.returned}`);
    console.log(base.results.length ? table(RESULT_HEADERS, resultRows(base.results)) : "(no Base tokens passed the filters right now)");
    console.log(warningsOf(base.results));
  });

  await step("3. detect_momentum_breakouts  chain=all", async () => {
    const r = await call("detect_momentum_breakouts", { chain: "all", limit: 5 });
    console.log(`scanned=${r.stats.scanned} breakouts=${r.stats.breakouts} returned=${r.stats.returned}`);
    const rows = r.results.map((x) => [x.rank, `$${x.symbol}`, x.chain, `${x.breakout.volumeAcceleration}x`, ratio(x.breakout.buyRatio5m), usd(x.breakout.m5VolumeUsd), x.breakout.m5Txns, pct(x.breakout.priceChangeM5), x.breakout.breakoutScore, x.alphaScore, x.security.status]);
    if (rows.length) console.log(table(["#", "Token", "Chain", "Vol accel", "Buy% 5m", "5m Vol", "5m Txns", "5m Px", "Breakout", "Alpha", "Security"], rows));
    else {
      console.log("No token met the breakout thresholds in this moment (expected most of the time). Near misses:");
      console.log(table(["Token", "Chain", "Vol accel", "Buy% 5m", "5m Txns", "Wash suspected"], r.nearMisses.map((x) => [`$${x.symbol}`, x.chain, `${x.breakout.volumeAcceleration}x`, ratio(x.breakout.buyRatio5m), x.breakout.m5Txns, x.breakout.washSuspected])));
    }
  });

  const pick = sol?.results?.[0] ?? base?.results?.[0];
  if (pick) {
    await step(`4. inspect_token  query=${pick.tokenAddress}  ($${pick.symbol})`, async () => {
      const r = await call("inspect_token", { query: pick.tokenAddress, chain: pick.chain });
      if (!r.found) throw new Error(r.message);
      const t = r.token;
      console.log(
        table(
          ["Metric", "Value"],
          [
            ["Token", `${t.name} ($${t.symbol}) on ${t.chain}`],
            ["Contract", t.tokenAddress],
            ["Price (exact)", t.priceUsd],
            ["Liquidity / FDV", `${usd(t.liquidityUsd)} / ${usd(t.fdv)}`],
            ["Price 5m/1h/6h/24h", ["m5", "h1", "h6", "h24"].map((k) => pct(t.priceChangePct?.[k])).join(" / ")],
            ["Volume 5m/1h/6h/24h", ["m5", "h1", "h6", "h24"].map((k) => usd(t.volumeUsd?.[k])).join(" / ")],
            ["Txns 1h (buys/sells)", `${t.txns?.h1?.buys} / ${t.txns?.h1?.sells}`],
            ["Avg trade (1h)", t.tradeQuality.avgTradeUsd1h === undefined ? "n/a" : `$${t.tradeQuality.avgTradeUsd1h}`],
            ["Pools", `${r.pools.length} (top: ${r.pools[0]?.dex})`],
            ["Socials", Object.keys(t.links.socials).join(", ") || "none"],
            ["Alpha Score", `${t.alphaScore}/100  ${JSON.stringify(t.scoreBreakdown)}`],
            ["Security", `${t.security.status}: ${t.security.verdict}`],
            ["URL", t.url],
          ],
        ),
      );
      console.log(`Warnings: ${t.warnings.join(" · ") || "none"}`);
    });

    await step(`5. audit_token_security  ${pick.chain} ${short(pick.tokenAddress)}`, async () => {
      const r = await call("audit_token_security", { chain: pick.chain, address: pick.tokenAddress });
      console.log(
        table(
          ["Field", "Value"],
          [
            ["Status", r.status],
            ["Source", r.source],
            ["Verdict", r.verdict],
            ["Risk score (0 safest)", r.riskScore ?? "n/a"],
            ["Mint authority", r.mintAuthorityActive === undefined ? "n/a" : r.mintAuthorityActive ? "ACTIVE" : "revoked"],
            ["Freeze authority", r.freezeAuthorityActive === undefined ? "n/a" : r.freezeAuthorityActive ? "ACTIVE" : "revoked"],
            ["Top holder / top-10", `${r.topHolderPct ?? "n/a"}% / ${r.top10HolderPct ?? "n/a"}% (pools excluded)`],
            ["Honeypot / taxes", r.isHoneypot === undefined ? "n/a" : `${r.isHoneypot} / buy ${r.buyTax} sell ${r.sellTax}`],
            ["Flags", r.flags.slice(0, 3).join(" · ") || "none"],
          ],
        ),
      );
    });
  }

  await step("5b. audit_token_security  EVM (Base WETH) and a known-bad profile (Solana USDC freeze authority)", async () => {
    const a = await call("audit_token_security", { chain: "base", address: "0x4200000000000000000000000000000000000006" });
    const b = await call("audit_token_security", { chain: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" });
    console.log(table(["Chain", "Token", "Status", "Verdict"], [["base", "WETH", a.status, a.verdict.slice(0, 90)], ["solana", "USDC", b.status, b.verdict.slice(0, 90)]]));
  });

  await step("6. compare_watchlist  (top scan results + two blue chips)", async () => {
    const tokens = [...(sol?.results ?? []).slice(0, 3), ...(base?.results ?? []).slice(0, 2)].map((x) => ({ address: x.tokenAddress, chain: x.chain }));
    tokens.push({ address: "So11111111111111111111111111111111111111112" }, { address: "0x4200000000000000000000000000000000000006" });
    const r = await call("compare_watchlist", { tokens });
    console.log(`requested=${tokens.length} ranked=${r.count} notFound=${r.notFound.length}`);
    console.log(table(["Rank", "Token", "Chain", "Alpha", "Liq", "Buy% 1h", "Security", "Rejected"], r.ranking.map((x) => [x.rank, `$${x.symbol}`, x.chain, x.alphaScore, usd(x.liquidityUsd), ratio(x.buyRatio.h1), x.security.status, x.rejected])));
    console.log(warningsOf(r.ranking));
  });

  section("Timings");
  console.log(table(["Tool", "Arg", "ms", "result"], timings));
} finally {
  await client.close();
}
if (failed) {
  console.error(`\n${failed} step(s) failed`);
  process.exit(1);
}
console.log("\nAll 5 tools executed end-to-end against live data.");
