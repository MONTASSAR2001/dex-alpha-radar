---
name: dex-alpha-radar
description: Discover, vet and paper-trade meme coins in real time. Use when the user asks to find trending, new, boosted or breakout meme coins or tokens, or brand-new launches in their first minutes (fresh births, minute-0, just launched, sniping research), check whether a token (symbol, name or contract address) is safe, a rug pull or a honeypot, audit a Solana mint or EVM contract, investigate whales, bundlers or insiders, check for copycats or a real narrative, compare a watchlist, simulate or paper-trade a token, prepare a Jupiter swap for Phantom, or review trade journal performance. Uses DexScreener, RugCheck, GoPlus and Jupiter. Simulation by default; it never signs a transaction on its own.
license: MIT
compatibility: Needs Node.js 20+ and internet access. Uses the dex-alpha-radar MCP server (zero config) or the public REST APIs directly.
metadata:
  author: Montassar Zarai
  version: "1.2.0"
  repository: https://github.com/MONTASSAR2001/dex-alpha-radar
---

# dex-alpha-radar

Real-time meme coin discovery, momentum scoring and anti-rug auditing, backed by **DexScreener** (market data), **RugCheck** (Solana contracts) and **GoPlus Security** (EVM contracts). No API keys.

> **This is research tooling, not financial advice.** Meme coins are extremely high risk and most go to zero. A passing audit lowers, but never removes, rug-pull risk. Never present output as a recommendation to buy.

## Tools

The MCP server `dex-alpha-radar` exposes ten tools. Prefer them over scraping or ad-hoc HTTP calls: they are rate-limit safe, cached for 12 s, and fail closed.

| Tool | Use it when the user wants to... | Key inputs |
|---|---|---|
| `scan_opportunities` | find the best new or boosted tokens right now | `chain` (`all`/`solana`/`base`/...), `minLiquidityUsd` (15000), `maxAgeHours` (72), `includeRisky` (false), `limit`, `useBrowserTrending` (false) |
| `inspect_token` | deep-dive one token by symbol, name or contract address | `query`, optional `chain` |
| `audit_token_security` | check whether a contract is safe | `chain`, `address` |
| `detect_momentum_breakouts` | catch sudden 5-minute volume and buy-pressure surges early | `chain`, `minAcceleration` (2), `minBuyRatio` (0.6), `limit` |
| `detect_fresh_births` | catch tokens in their first minutes (0-20 min, incl. Minute 0-2 launches), freshest first, with logo, exact age and every direct link | `maxAgeMinutes` (20), `chain`, `minLiquidityUsd` (0), `limit` (30), `includeRisky` (false) |
| `compare_watchlist` | rank several tokens side by side | `tokens: [{address, chain?}]` |
| `analyze_whale_forensics` | check holders: whale concentration, insider wallet networks, bundled launches | `address`, `chain` (Solana gets the full bundle analysis; EVM gets concentration only) |
| `evaluate_narrative_pulse` | judge the narrative: attention momentum, **copycat risk** vs trending tokens, social links | `query` (symbol, name or CA), `chain` |
| `simulate_or_prepare_trade` | paper-trade a token, run the profit guard, list positions, or prepare an unsigned swap for the user's wallet | `action` (`buy`/`sell`/`monitor`/`positions`), `tokenAddress`, `sizeUsd`, `paperMode` (**default true**), `walletPublicKey`, `autoExecute` (see [Trading protocol](#trading-protocol)) |
| `analyze_trade_journal` | review paper/live trade performance and get threshold-tuning suggestions | `mode` (`paper`), `minSample` (5), `since`, `onlyRuleCompliant` |

`useBrowserTrending: true` additionally reads DexScreener's trending view with a local headless Chrome. Use it only if the user asks for "trending" specifically, because it is slower (up to about 40 s) and optional. Check the `trending.status` field in the result: if it is not `ok` (for example `blocked` by a bot check, or `unavailable` without Chrome), tell the user the trending view was skipped and that results come from the API sources only. Never claim trending data was used when the status is not `ok`.

If the tools are not available, see [Setup](#setup-if-the-tools-are-missing).

## Workflow (follow in order)

1. **Clarify only what is missing.** Defaults are fine: chain `all`, liquidity $15k, age 72 h. Do not interrogate the user.
2. **Discover.** `scan_opportunities` for broad requests, `detect_momentum_breakouts` for "what is pumping right now", `detect_fresh_births` for "what just launched" / "minute-0 tokens", `inspect_token` when a specific token is named.
3. **Verify every candidate you present.** Results already include a security audit. For anything you will highlight, also call `audit_token_security` (deep audit: authority addresses, holder concentration) and check `inspect_token.warnings` for copycat tokens.
4. **Surface every warning.** Each result has a `warnings` array (bot volume, holder concentration, unverified contract, thin liquidity, very new pair, copycat tickers). Show the warnings for every token you present; never drop them to make a list look cleaner.
5. **Cross-check identity.** Symbols are not unique and scammers clone popular tickers. Always show the full contract address and the DexScreener URL, and state which chain it is on.
6. **Go deeper on finalists** (not on every row): `analyze_whale_forensics` for holder and bundle risk, `evaluate_narrative_pulse` for copycat risk and social presence. A token that is `BUNDLE_DETECTED` or a likely late copycat is not an opportunity, whatever its Alpha Score.
7. **Present** using the templates below. Lead with the security verdict, then the numbers.
8. **Close with the disclaimer** (verbatim, below).

## Trading protocol

`simulate_or_prepare_trade` has three levels. Move up a level only when the user explicitly asks.

1. **Paper (default).** `paperMode` is true: nothing touches a wallet. It simulates a fill with live DexScreener and Jupiter prices, 2% slippage and Solana priority fees, records the position in `~/.dex-alpha-radar/trades.json`, and runs the Trailing Profit Guard. Use it freely when the user wants to test an idea.
2. **Prepare (`paperMode: false`, no `autoExecute`).** Returns an **unsigned** Jupiter swap transaction (`unsignedTransactionBase64`) for the user's own wallet (`walletPublicKey`, e.g. Phantom) to review and sign. Before calling it, restate the token, contract address, chain, USD size, slippage and wallet, and get an explicit "yes". Afterwards, show the expected and minimum tokens, the price impact and `lastValidBlockHeight`, and say the user must sign it. Prepared trades are not recorded in the ledger.
3. **Auto-execute (`autoExecute: true`).** Signs and sends with a burner wallet configured by the user in the server environment. Only when the user explicitly asks for auto-execution for this specific trade, after the same confirmation. The server enforces its own guardrails (`DEX_ALPHA_ALLOW_LIVE_EXECUTION`, `MAX_TRADE_USD`, `DAILY_LOSS_LIMIT_USD`); if it answers `blocked` with `problems`, report them and stop. Do not try to work around a guardrail.

Entry rules (always enforced for live trades): pair age <= 5 minutes, security `SAFE`, Alpha >= 70, holder forensics `CLEAN_DISTRIBUTION`, no copycat flag. Fail-closed: unavailable forensics block the trade. If a buy comes back `blocked`, show `failed` and the rule checks. Do **not** retry with `enforceEntryRules: false` on your own; only if the user asks for an experimental paper trade, and then call it experimental (it is flagged in the journal).

Trailing Profit Guard (applied by `action: "monitor"` and, for paper positions, by the server's background monitor): stop loss -30%, stop moves to break-even at +50%, take profit at +100%, emergency exit if liquidity drops more than 20%. It acts on the prices it observes when it runs, so a spike and reversal between two checks can be missed. Live positions are never sold by the background monitor: `monitor` only reports `exitSignals` unless the user explicitly asks for `autoExecute`.

Never: ask for, accept, repeat or store a private key or seed phrase; put a key in any tool argument (there is no such parameter); read or print environment variables; or set the guardrail variables yourself. Do not choose a position size for a live trade: the user decides `sizeUsd`.

## Hard rules

- **Fail closed.** `UNVERIFIED` means *no usable audit data*. Say "unverified, treat as unsafe". Never describe it as safe, "probably fine" or "low risk".
- **`DANGER` or `rejected: true` is a veto.** Do not list it as an opportunity. If it appears (`includeRisky: true`), label it clearly as a rejected token and say why.
- **Volume can be fake.** If `tradeQuality.washSuspected` is true (average trade under $15 over many transactions, or 1h volume above 20x liquidity with a flat price), say the volume is likely bot-driven and do not present the token as having organic momentum, whatever its score.
- **Use exact prices.** Copy `priceUsd` exactly as returned (it is a string). Never round it, re-derive it, or rewrite tiny prices with subscript zeros or scientific notation.
- **Never invent data.** If a field is missing, write `n/a`. Do not estimate liquidity, holders or taxes.
- **No unrequested trades, no advice.** Follow the [Trading protocol](#trading-protocol). Do not suggest buying, position sizes or price targets, and never describe paper results as predictive of real results (simulated fills cannot capture failed transactions, bots or a rug that freezes selling).
- **Holder and bundle risk is a veto.** `BUNDLE_DETECTED` and `INSUFFICIENT_DATA` are not "clean". Say so, and note that EVM tokens only get concentration data.
- **Copycats.** If `evaluate_narrative_pulse` returns `LATE_COPYCAT` (or `copycatFlag: true`), name the original it matched and do not present the token as an opportunity. A `MEDIUM` ticker-only match (an older token with the same ticker but a different name) is a prompt to verify the project, not proof of a copy. Social links are format-checked from DexScreener's listing, not verified accounts, and the tool does not measure tweet or chat volume: never claim it does.
- **Report tool errors honestly.** Include any `warnings` from tool output. If a source was unavailable, say so rather than filling the gap.
- Unsupported chains (anything besides Solana, Ethereum, Base, BSC, Arbitrum, Polygon) are always `UNVERIFIED`.

## Reading the Alpha Score (0-100)

Deterministic and transparent; every result includes `scoreBreakdown` and `reasons`.

| Component | Max | What earns points |
|---|---|---|
| Liquidity health | 25 | Pool depth ($25k-$500k+ healthy, under $10k penalised) and liquidity relative to FDV |
| Buy/sell pressure | 25 | 5m and 1h buy ratio; strong above 60% buys, discounted when sample is tiny |
| Volume velocity | 25 | 1h volume / liquidity turnover, and 5m acceleration (`m5 volume x 12` above `h1 volume`) |
| Socials and catalysts | 15 | Website, X, Telegram (3 each), active DexScreener boost (3), community takeover (3) |
| Manipulation | 0 to -20 | Bot / wash-trading signals: average 1h trade under $15 with 50+ transactions (up to -12), or 1h volume above 20x liquidity with flat price (-10) |
| Security | +10 / -50 | Verified `SAFE` +10, `WARNING` -5, `UNVERIFIED` 0, `DANGER` -50 and **REJECTED** |

| Score | Reading |
|---|---|
| 75-100 | Exceptionally strong setup: verify manually before anything else |
| 55-74 | Solid momentum with healthy structure |
| 35-54 | Mixed: one or more weak components |
| 0-34 | Weak, thin or risky |

A high score means strong *market structure*, not a safe or profitable token.

## Output templates

### Opportunity scan

```markdown
**Scan: {chain} | liquidity >= ${minLiquidityUsd} | age <= {maxAgeHours}h | {generatedAt}**

| # | Token | Chain | Price (USD) | Liq | FDV | Age | 5m / 1h / 24h | Buy% 5m / 1h | Avg trade 1h | Alpha | Security |
|---|-------|-------|-------------|-----|-----|-----|---------------|--------------|--------------|-------|----------|
| 1 | $SYMBOL | solana | 0.00001234 | $54.4k | $1.2M | 0.4h | +3% / +12% / +50% | 75% / 67% | $36.80 | 69 | SAFE |

**Why #1 ranks first:** {top 3 items from `reasons`}
**Contract:** `{tokenAddress}` | [DexScreener]({url})
**Warnings:** {every entry of `warnings`, per token; write "none" if empty}
```

### Token deep-dive

```markdown
## {name} (${symbol}) on {chain}   Alpha {alphaScore}/100 | Security: {status}

| Metric | Value |
|---|---|
| Price | {priceUsd} |
| FDV / Market cap | {fdv} / {marketCap} |
| Liquidity | {liquidityUsd} |
| Price change 5m / 1h / 6h / 24h | ... |
| Volume 5m / 1h / 6h / 24h | ... |
| Buys / Sells (5m, 1h) | ... |
| Pair age | {ageHours}h |
| Links | website, X, Telegram |

**Security:** {verdict}
**Flags:** {flags}
**Contract:** `{tokenAddress}` | [DexScreener]({url})
**Other tokens sharing this symbol:** {otherMatches or "none found"}
```

### Security audit

```markdown
## Audit: {address} ({chain}) : {status}

| Check | Result |
|---|---|
| Verdict | {verdict} |
| Risk score (RugCheck, 0 safest to 100 riskiest) | {riskScore} |
| Mint authority | active / revoked |
| Freeze authority | active / revoked |
| Top holder / top 10 | {topHolderPct}% / {top10HolderPct}% (may include pool vaults) |
| Honeypot / cannot sell all | yes/no / yes/no |
| Buy tax / sell tax | {buyTax} / {sellTax} |
| Contract source verified | yes/no |

**Flags:** {flags}
```

### Watchlist comparison

```markdown
| Rank | Token | Chain | Alpha | Liq | Buy% 1h | Vol 1h / Liq | Security | Verdict |
|------|-------|-------|-------|-----|---------|--------------|----------|---------|
```
Rejected tokens are listed last and marked **REJECTED**. List any `notFound` addresses beneath the table.

### Momentum breakouts

```markdown
| # | Token | Chain | Vol accel (m5x12 / h1) | Buy% 5m | 5m Vol | 5m Txns | 5m Price | Breakout | Security |
|---|-------|-------|------------------------|---------|--------|---------|----------|----------|----------|
```
If `results` is empty, say no breakout met the thresholds and show `nearMisses`. Breakouts are early and unconfirmed: note that a single 5-minute window can be wash trading.

### Fresh births (first minutes)

```markdown
| # | Age | Token | Chain / DEX | Price | MCap | Liquidity | 5m Vol | 5m % | 5m Buys/Sells | Velocity | Security |
|---|-----|-------|-------------|-------|------|-----------|--------|------|---------------|----------|----------|
```
Sort order is `ageSeconds` ascending (freshest first); show the exact age (`0m 42s`, `4m`). For every token also give the links: `dexscreenerUrl`, `tradeUrl` (`tradeLabel`), `explorerUrl` (`explorerLabel`) and any `socials`. Label `isMinuteZero` tokens (under 3 minutes) clearly as Minute-0 launches and say that this is the highest rug-risk window: most have no audit data yet (`UNVERIFIED` = unsafe), liquidity is thin and 5-minute stats are statistically meaningless with a handful of transactions. A high `velocityScore` means fast early buying, not safety. Never present a fresh birth as a recommendation.

### Whale forensics

```markdown
## Holders: {symbol} ({chain})   {verdict}   Holder Safety {holderSafetyScore}/100 ({band})

| Metric | Value |
|---|---|
| Top 1 / top 5 / top 10 wallets | {top1Pct}% / {top5Pct}% / {top10Pct}% (pools, lockers, exchanges excluded) |
| Creator holds | {creatorPct}% |
| Insider networks / still held / routed at launch | {networks.length} / {networkHoldingPct}% / {networkDistributedPct}% |
| Insider-graph wallets | {graphInsidersDetected} |
| Buys per holder (24h) | {buysPerHolder24h} (churn suspected: {churnSuspected}) |

**Why:** {reasons}   **Warnings:** {warnings}
```
`INSUFFICIENT_DATA` means no usable holder report: say "cannot rule out a bundled launch", never "clean".

### Narrative pulse

```markdown
## Narrative: {symbol} ({chain})   {verdict}   Momentum {momentum.score}/100   Copycat risk: {copycat.risk}

| Check | Result |
|---|---|
| Attention momentum | {momentum.score}/100 ({top reasons}) |
| Copycat | {copycat.summary}; matches: {symbol, chain, launched X min earlier, liquidity} |
| Website / X / Telegram | listed + format valid? (score {social.score}/100) |
| Crowded theme | {theme.peers or "none"} |

**Warnings:** {warnings}   *(momentum is market attention, not social-post volume)*
```

### Paper trade / prepared swap

```markdown
**{PAPER SIMULATION | UNSIGNED TRANSACTION}**: {symbol} ({chain}) `{tokenAddress}`

| Item | Value |
|---|---|
| Size / slippage / priority fee | ${sizeUsd} / {slippageBps/100}% / {priorityFeeLamports} lamports |
| Market price -> fill price | {refPriceUsd} -> {fillPriceUsd} (source: {fill.source}) |
| Entry gate | age {ageMinutes} min, security {security}, Alpha {alphaScore}, forensics {forensics}, copycat {copycatRisk} |
| Guard | SL -30% | break-even at +50% | TP +100% | emergency if liquidity -20% |
```
For a blocked trade list each entry of `failed`. For a prepared swap add the expected/minimum tokens, price impact and the reminder that the user signs and sends it.

### Trade journal

```markdown
| Trades | Win rate | Net PnL | Avg PnL | Profit factor | Best chain | Best launch-age window |
|--------|----------|---------|---------|---------------|------------|------------------------|

**Suggested threshold changes (in-sample, confidence {confidence}):** {parameter}: {current} -> {suggested} ({evidence})
```
If `optimizations` is empty, repeat `optimizationNote`. Present suggestions as hypotheses to test on new trades, never as proven improvements.

## Required disclaimer (end every answer that lists tokens)

> **Not financial advice.** Meme coins are extremely high-risk and can lose 100% of their value instantly. Security audits reduce but cannot eliminate rug-pull, honeypot or insider risk. Data comes from third-party APIs and may be delayed or wrong. Verify the contract address yourself and never risk money you cannot afford to lose.

## Setup if the tools are missing

The skill ships its own zero-config launcher. Register the MCP server once, using the absolute path to this skill's folder (where `scripts/mcp-launch.mjs` lives):

```json
{ "mcpServers": { "dex-alpha-radar": { "command": "node", "args": ["/ABSOLUTE/PATH/TO/dex-alpha-radar/scripts/mcp-launch.mjs"] } } }
```

The first start installs dependencies and compiles automatically (about 30 s, Node 20+). Claude Code: `claude mcp add dex-alpha-radar -- node /ABSOLUTE/PATH/TO/dex-alpha-radar/scripts/mcp-launch.mjs`.

### Optional: live execution settings (user-controlled)

Paper trading and unsigned swaps need no configuration. Burner-wallet auto-execution is off unless the **user** sets all of these in the MCP server's environment: `DEX_ALPHA_ALLOW_LIVE_EXECUTION=true`, `SOLANA_BURNER_PRIVATE_KEY` (a dedicated wallet holding only money they can lose), `MAX_TRADE_USD`, `DAILY_LOSS_LIMIT_USD`, optionally `SOLANA_RPC_URL`. Other settings: `DEX_ALPHA_MONITOR_INTERVAL_SEC` (paper guard, default 30, 0 disables), `DEX_ALPHA_RADAR_HOME` (ledger folder), `JUPITER_API_URL` (override the Jupiter host). Jupiter is tried at `quote-api.jup.ag/v6` first and falls back to `lite-api.jup.ag/swap/v1`.

### Fallback: no MCP available

Use the public APIs directly (no keys). Respect limits: 60 req/min for boosts/profiles/CTO, 300 req/min for the rest.

- Boosted / new: `https://api.dexscreener.com/token-boosts/latest/v1`, `/token-boosts/top/v1`, `/token-profiles/latest/v1`, `/community-takeovers/latest/v1`
- Market data: `https://api.dexscreener.com/tokens/v1/{chainId}/{addr1,addr2,...}` (max 30), `/latest/dex/search?q={query}`
- Solana audit: `https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary` (`score_normalised`: under 21 SAFE, 21-40 WARNING, above 40 DANGER; any active mint or freeze authority is DANGER)
- EVM audit: `https://api.gopluslabs.io/api/v1/token_security/{chainId}?contract_addresses={addr}` (chain ids: ethereum 1, bsc 56, base 8453, arbitrum 42161, polygon 137; `is_honeypot`, `buy_tax`, `sell_tax`, `cannot_sell_all`, `owner_change_balance`, `is_open_source`)

Apply the same hard rules, including fail-closed behaviour when an audit returns nothing.
