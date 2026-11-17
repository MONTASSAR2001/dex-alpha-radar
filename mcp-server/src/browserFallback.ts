/**
 * Optional headless-browser fallback: reads the pair addresses listed on DexScreener's
 * trending view (which the public REST API does not expose).
 *
 * Everything here is best-effort and degrades gracefully:
 *  - `playwright-core` is an optional dependency, loaded dynamically
 *  - a Chromium/Chrome executable is auto-detected (no browser download happens)
 *  - if DexScreener serves a bot-verification challenge (Cloudflare), the result is
 *    `blocked` with an explanation. The challenge is NOT bypassed or evaded.
 *
 * It never throws: callers get a status and a message, and fall back to the REST pipeline.
 */
/// <reference lib="dom" />
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { looksLikeEvmAddress, looksLikeSolanaAddress } from "./chains.js";

export type TrendingStatus = "ok" | "empty" | "blocked" | "unavailable" | "error";

export interface TrendingPairRef {
  chainId: string;
  pairAddress: string;
  /** 1-based position on the trending list. */
  rank: number;
}

export interface BrowserTrendingResult {
  status: TrendingStatus;
  pairs: TrendingPairRef[];
  message: string;
  /** Executable used, when a browser was launched. */
  browser?: string;
}

export interface BrowserTrendingOptions {
  /** Restrict to one chain, e.g. "solana" (uses DexScreener's per-chain trending page). */
  chain?: string;
  /** Maximum pairs to return (default 30, the batch size of the pairs endpoint). */
  limit?: number;
  /** Overall budget for page load + challenge wait + extraction. Default 40 s. */
  timeoutMs?: number;
  /** Override the page URL (tests). */
  url?: string;
  /** Explicit browser executable. Else env DEX_ALPHA_CHROME_PATH / CHROME_PATH, then auto-detect. */
  executablePath?: string;
  /** Default true. Set DEX_ALPHA_BROWSER_HEADLESS=0 to watch/solve a challenge yourself. */
  headless?: boolean;
  /** Persistent profile dir (DEX_ALPHA_BROWSER_PROFILE), e.g. one where you already passed the check. */
  userDataDir?: string;
  /** Dependency injection for tests. */
  loadPlaywright?: () => Promise<PlaywrightLike | undefined>;
  findExecutable?: (override?: string) => string | undefined;
}

// ---- minimal structural types so the module compiles without playwright-core installed ----
interface PageLike {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  evaluate<T>(fn: () => T): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
}
interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
interface BrowserLike extends ContextLike {
  newContext(opts?: Record<string, unknown>): Promise<ContextLike>;
}
export interface PlaywrightLike {
  chromium: {
    launch(opts: Record<string, unknown>): Promise<BrowserLike>;
    launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<ContextLike>;
    executablePath(): string;
  };
}

const TRENDING_URL = "https://dexscreener.com/?rankBy=trendingScoreH6&order=desc";

export function trendingUrl(chain?: string): string {
  const c = chain?.trim().toLowerCase();
  if (!c || c === "all") return TRENDING_URL;
  if (!/^[a-z0-9-]+$/.test(c)) throw new Error(`Invalid chain: ${chain}`);
  return `https://dexscreener.com/${c}?rankBy=trendingScoreH6&order=desc`;
}

/** `/solana/<pair>` -> ref. Rejects navigation links such as `/gainers` or `/new-pairs`. */
export function parseTrendingHref(href: string | null | undefined): Omit<TrendingPairRef, "rank"> | undefined {
  if (!href) return undefined;
  const path = href.split(/[?#]/)[0] ?? "";
  const m = /^\/([a-z0-9-]{2,30})\/([A-Za-z0-9]{32,66})\/?$/.exec(path);
  if (!m) return undefined;
  const [, chainId, pairAddress] = m as unknown as [string, string, string];
  const valid = looksLikeEvmAddress(pairAddress) || looksLikeSolanaAddress(pairAddress) || /^0x[0-9a-fA-F]{64}$/.test(pairAddress);
  return valid ? { chainId, pairAddress } : undefined;
}

export function extractTrendingPairs(hrefs: readonly (string | null | undefined)[], limit = 30): TrendingPairRef[] {
  const seen = new Set<string>();
  const out: TrendingPairRef[] = [];
  for (const h of hrefs) {
    const p = parseTrendingHref(h);
    if (!p) continue;
    const key = `${p.chainId}:${p.pairAddress.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...p, rank: out.length + 1 });
    if (out.length >= limit) break;
  }
  return out;
}

/** True for Cloudflare-style "verify you are human" interstitials. */
export function isChallengePage(title: string, bodyText: string): boolean {
  return /just a moment|attention required|verify you are human/i.test(title) || /security verification|verify you are not a bot|checking your browser|enable javascript and cookies/i.test(bodyText.slice(0, 2000));
}

const COMMON_EXECUTABLES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** Finds an installed Chromium-family browser. Never downloads anything. */
export function findBrowserExecutable(override?: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  for (const c of [override, env.DEX_ALPHA_CHROME_PATH, env.CHROME_PATH, ...COMMON_EXECUTABLES]) {
    if (c && exists(c)) return c;
  }
  return undefined;
}

async function defaultLoadPlaywright(): Promise<PlaywrightLike | undefined> {
  try {
    const name = "playwright-core"; // non-literal: optional dependency, resolved at runtime only
    const mod = (await import(name)) as { default?: PlaywrightLike } & Partial<PlaywrightLike>;
    return (mod.chromium ? (mod as PlaywrightLike) : mod.default) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function fetchBrowserTrending(opts: BrowserTrendingOptions = {}): Promise<BrowserTrendingResult> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 60);
  const budget = opts.timeoutMs ?? 40_000;
  let url: string;
  try {
    url = opts.url ?? trendingUrl(opts.chain);
  } catch (e) {
    return { status: "error", pairs: [], message: e instanceof Error ? e.message : String(e) };
  }

  const pw = await (opts.loadPlaywright ?? defaultLoadPlaywright)();
  if (!pw) {
    return {
      status: "unavailable",
      pairs: [],
      message: "Browser trending unavailable: the optional dependency `playwright-core` is not installed (run `npm install` in mcp-server). Using API sources only.",
    };
  }
  const exe =
    (opts.findExecutable ?? ((o?: string) => findBrowserExecutable(o)))(opts.executablePath) ??
    (() => {
      try {
        const p = pw.chromium.executablePath();
        return p && existsSync(p) ? p : undefined;
      } catch {
        return undefined;
      }
    })();
  if (!exe) {
    return {
      status: "unavailable",
      pairs: [],
      message: "Browser trending unavailable: no Chrome/Chromium found. Install one or set DEX_ALPHA_CHROME_PATH. Using API sources only.",
    };
  }

  const headless = opts.headless ?? process.env.DEX_ALPHA_BROWSER_HEADLESS !== "0";
  const profile = opts.userDataDir ?? process.env.DEX_ALPHA_BROWSER_PROFILE ?? undefined;
  const launchOpts: Record<string, unknown> = {
    executablePath: exe,
    headless,
    // Chrome's sandbox cannot start as root (containers/CI).
    args: typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : [],
    timeout: Math.min(budget, 30_000),
  };

  let closeable: { close(): Promise<void> } | undefined;
  const started = Date.now();
  try {
    let page: PageLike;
    if (profile) {
      const ctx = await pw.chromium.launchPersistentContext(profile.startsWith("~") ? join(homedir(), profile.slice(1)) : profile, launchOpts);
      closeable = ctx;
      page = await ctx.newPage();
    } else {
      const browser = await pw.chromium.launch(launchOpts);
      closeable = browser;
      page = await (await browser.newContext()).newPage();
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(budget, 30_000) });

    // Poll for rows. If a human-verification page persists past a grace period, report `blocked`.
    const challengeGraceMs = Math.min(12_000, budget / 2);
    let challengeSince: number | undefined;
    for (;;) {
      const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")));
      const pairs = extractTrendingPairs(hrefs, limit);
      if (pairs.length >= 3) {
        return { status: "ok", pairs, browser: exe, message: `Extracted ${pairs.length} trending pairs from ${url}` };
      }
      const [title, body] = [await page.title(), await page.evaluate(() => document.body?.innerText ?? "")];
      if (isChallengePage(title, body)) {
        challengeSince ??= Date.now();
        if (Date.now() - challengeSince > challengeGraceMs) {
          return {
            status: "blocked",
            pairs: [],
            browser: exe,
            message:
              "DexScreener served a bot-verification challenge to the headless browser; it was not bypassed. Using API sources only. To use the trending view, pass a profile where you already passed the check (DEX_ALPHA_BROWSER_PROFILE) with DEX_ALPHA_BROWSER_HEADLESS=0.",
          };
        }
      }
      if (Date.now() - started > budget) {
        return pairs.length
          ? { status: "ok", pairs, browser: exe, message: `Extracted only ${pairs.length} trending pairs before the timeout` }
          : { status: "empty", pairs: [], browser: exe, message: "No trending pairs found on the page before the timeout (page layout may have changed)." };
      }
      await page.waitForTimeout(750);
    }
  } catch (e) {
    return { status: "error", pairs: [], browser: exe, message: `Browser trending failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}. Using API sources only.` };
  } finally {
    await closeable?.close().catch(() => undefined);
  }
}
