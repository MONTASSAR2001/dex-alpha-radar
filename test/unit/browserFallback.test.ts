import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractTrendingPairs,
  fetchBrowserTrending,
  findBrowserExecutable,
  isChallengePage,
  parseTrendingHref,
  trendingUrl,
  type PlaywrightLike,
} from "../../mcp-server/src/browserFallback.js";

const SOL_PAIR = "Ak7hDCxDSocD2ZgJBCa1ZwLcuDQz5F6n747a7rQtpXE3";
const SOL_PAIR_2 = "DzYtzoNvPbyFCzwZA6cSm9eDEEmxEB9f8AGkJXUXgnSA";
const EVM_PAIR = "0x4c36388be6f416a29c8d8eee81c771ce6be14b18";

describe("parseTrendingHref / extractTrendingPairs", () => {
  it("accepts chain/pair links and rejects navigation links", () => {
    assert.deepEqual(parseTrendingHref(`/solana/${SOL_PAIR}`), { chainId: "solana", pairAddress: SOL_PAIR });
    assert.deepEqual(parseTrendingHref(`/base/${EVM_PAIR}?maker=0x1`), { chainId: "base", pairAddress: EVM_PAIR });
    assert.deepEqual(parseTrendingHref(`/base/0x${"a".repeat(64)}`)?.chainId, "base");
    for (const bad of ["/gainers", "/new-pairs", "/solana", "/solana/short", "https://x.com/a/b", "", null, undefined, `/solana/${SOL_PAIR}/extra`, `/s/${SOL_PAIR}`]) {
      assert.equal(parseTrendingHref(bad), undefined, String(bad));
    }
  });

  it("keeps order, de-duplicates and honours the limit", () => {
    const hrefs = ["/gainers", `/solana/${SOL_PAIR}`, `/solana/${SOL_PAIR}?x=1`, `/base/${EVM_PAIR}`, `/solana/${SOL_PAIR_2}`, null];
    const all = extractTrendingPairs(hrefs);
    assert.deepEqual(all.map((p) => [p.rank, p.chainId]), [[1, "solana"], [2, "base"], [3, "solana"]]);
    assert.equal(extractTrendingPairs(hrefs, 2).length, 2);
  });

  it("trendingUrl builds global and per-chain URLs and rejects unsafe chains", () => {
    assert.match(trendingUrl(), /^https:\/\/dexscreener\.com\/\?rankBy=trendingScoreH6/);
    assert.match(trendingUrl("all"), /^https:\/\/dexscreener\.com\/\?/);
    assert.match(trendingUrl("Solana"), /^https:\/\/dexscreener\.com\/solana\?rankBy=/);
    assert.throws(() => trendingUrl("../evil"));
  });
});

describe("isChallengePage", () => {
  it("recognises verification interstitials by title or body", () => {
    assert.equal(isChallengePage("Just a moment...", ""), true);
    assert.equal(isChallengePage("dexscreener.com", "Performing security verification. This website uses a security service to protect against malicious bots."), true);
    assert.equal(isChallengePage("DEX Screener", "Trending pairs on all chains"), false);
  });
});

describe("findBrowserExecutable", () => {
  it("prefers explicit override, then env, then common locations", () => {
    const exists = (p: string) => ["/opt/mine/chrome", "/env/chrome", "/usr/bin/chromium"].includes(p);
    assert.equal(findBrowserExecutable("/opt/mine/chrome", {}, exists), "/opt/mine/chrome");
    assert.equal(findBrowserExecutable(undefined, { DEX_ALPHA_CHROME_PATH: "/env/chrome" }, exists), "/env/chrome");
    assert.equal(findBrowserExecutable(undefined, { CHROME_PATH: "/missing" }, exists), "/usr/bin/chromium");
    assert.equal(findBrowserExecutable(undefined, {}, () => false), undefined);
  });
});

// ---- fake Playwright: no real browser involved ----
interface FakePage {
  hrefs?: (string | null)[];
  title?: string;
  body?: string;
}
function fakePlaywright(page: FakePage, log: string[] = [], opts: { launchThrows?: boolean } = {}): PlaywrightLike {
  const pageObj = {
    goto: async (url: string) => void log.push(`goto ${url}`),
    title: async () => page.title ?? "DEX Screener",
    evaluate: async (fn: () => unknown) => {
      const src = String(fn);
      return src.includes("innerText") ? (page.body ?? "") : (page.hrefs ?? []);
    },
    waitForTimeout: async (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
  };
  const ctx = { newPage: async () => pageObj, close: async () => void log.push("closed") };
  return {
    chromium: {
      launch: async () => {
        if (opts.launchThrows) throw new Error("spawn ENOENT\nstack...");
        return { ...ctx, newContext: async () => ctx };
      },
      launchPersistentContext: async (dir: string) => {
        log.push(`profile ${dir}`);
        return ctx;
      },
      executablePath: () => "/nonexistent/playwright-chromium",
    },
  } as unknown as PlaywrightLike;
}
const exe = () => "/usr/bin/fake-chrome";

describe("fetchBrowserTrending degradation", () => {
  it("unavailable when playwright-core is not installed", async () => {
    const r = await fetchBrowserTrending({ loadPlaywright: async () => undefined });
    assert.equal(r.status, "unavailable");
    assert.match(r.message, /playwright-core/);
    assert.deepEqual(r.pairs, []);
  });

  it("unavailable when no browser is installed", async () => {
    const r = await fetchBrowserTrending({ loadPlaywright: async () => fakePlaywright({}), findExecutable: () => undefined });
    assert.equal(r.status, "unavailable");
    assert.match(r.message, /no Chrome\/Chromium found/);
  });

  it("error (never a throw) when the browser fails to launch, with a one-line message", async () => {
    const r = await fetchBrowserTrending({ loadPlaywright: async () => fakePlaywright({}, [], { launchThrows: true }), findExecutable: exe });
    assert.equal(r.status, "error");
    assert.match(r.message, /spawn ENOENT/);
    assert.ok(!r.message.includes("stack..."));
  });

  it("error for an invalid chain without touching the browser", async () => {
    let loaded = false;
    const r = await fetchBrowserTrending({ chain: "../x", loadPlaywright: async () => ((loaded = true), undefined) });
    assert.equal(r.status, "error");
    assert.equal(loaded, false);
  });

  it("blocked when a bot-verification page persists (and the challenge is not bypassed)", async () => {
    const log: string[] = [];
    const r = await fetchBrowserTrending({
      loadPlaywright: async () => fakePlaywright({ title: "Just a moment...", body: "Performing security verification" }, log),
      findExecutable: exe,
      timeoutMs: 400,
    });
    assert.equal(r.status, "blocked");
    assert.match(r.message, /not bypassed/);
    assert.deepEqual(log.filter((l) => l !== "closed" && !l.startsWith("goto")), []);
    assert.ok(log.includes("closed"), "browser must be closed");
  });

  it("empty when the page loads but lists no pairs", async () => {
    const r = await fetchBrowserTrending({ loadPlaywright: async () => fakePlaywright({ hrefs: ["/gainers"], body: "hello" }), findExecutable: exe, timeoutMs: 300 });
    assert.equal(r.status, "empty");
  });
});

describe("fetchBrowserTrending success", () => {
  it("extracts ranked pairs from the page and closes the browser", async () => {
    const log: string[] = [];
    const r = await fetchBrowserTrending({
      chain: "solana",
      limit: 2,
      loadPlaywright: async () => fakePlaywright({ hrefs: ["/gainers", `/solana/${SOL_PAIR}`, `/solana/${SOL_PAIR_2}`, `/solana/${SOL_PAIR_2}`, `/solana/${"B".repeat(44)}`] }, log),
      findExecutable: exe,
    });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.pairs.map((p) => p.pairAddress), [SOL_PAIR, SOL_PAIR_2]);
    assert.equal(r.browser, "/usr/bin/fake-chrome");
    assert.ok(log[0]!.startsWith("goto https://dexscreener.com/solana?rankBy=trendingScoreH6"));
    assert.ok(log.includes("closed"));
  });

  it("uses a persistent profile when configured", async () => {
    const log: string[] = [];
    await fetchBrowserTrending({
      userDataDir: "/tmp/my-profile",
      loadPlaywright: async () => fakePlaywright({ hrefs: [`/solana/${SOL_PAIR}`, `/solana/${SOL_PAIR_2}`, `/base/${EVM_PAIR}`] }, log),
      findExecutable: exe,
    });
    assert.ok(log.includes("profile /tmp/my-profile"));
  });
});
