import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fetchBrowserTrending, findBrowserExecutable } from "../../mcp-server/src/browserFallback.js";
import { probeNetwork } from "./live.js";

async function browserAvailable(): Promise<string | undefined> {
  // The library resolves playwright-core from mcp-server/node_modules; probe the same place.
  if (!existsSync(fileURLToPath(new URL("../../mcp-server/node_modules/playwright-core/package.json", import.meta.url)))) {
    return "playwright-core is not installed";
  }
  return findBrowserExecutable() ? undefined : "no Chrome/Chromium found";
}

const skipBrowser = await browserAvailable();
const skipLive = skipBrowser ?? (await probeNetwork());

const P1 = "Ak7hDCxDSocD2ZgJBCa1ZwLcuDQz5F6n747a7rQtpXE3";
const P2 = "DzYtzoNvPbyFCzwZA6cSm9eDEEmxEB9f8AGkJXUXgnSA";
const P3 = "AqJ5JYNb7ApkJwvbuXxPnTtKeuizjvC1s2fkp382y9LC";
const E1 = "0x4c36388be6f416a29c8d8eee81c771ce6be14b18";

const TRENDING_HTML = `<!doctype html><title>DEX Screener</title><body>
  <nav><a href="/gainers">Gainers</a><a href="/new-pairs">New pairs</a><a href="/solana">Solana</a></nav>
  <div id="rows"></div>
  <script>
    // Rows render client-side after load, like the real app.
    setTimeout(() => {
      document.getElementById("rows").innerHTML = [
        '<a class="ds-dex-table-row" href="/solana/${P1}">1</a>',
        '<a class="ds-dex-table-row" href="/base/${E1}?x=1">2</a>',
        '<a class="ds-dex-table-row" href="/solana/${P2}">3</a>',
        '<a class="ds-dex-table-row" href="/solana/${P2}">dup</a>',
        '<a class="ds-dex-table-row" href="/solana/${P3}">4</a>',
      ].join("");
    }, 300);
  </script></body>`;

const CHALLENGE_HTML = `<!doctype html><title>Just a moment...</title><body><h1>dexscreener.com</h1><p>Performing security verification</p><p>This website uses a security service to protect against malicious bots.</p></body>`;

describe("browser trending against a real headless browser", { skip: skipBrowser }, () => {
  let server: Server;
  let base: string;
  before(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(req.url?.startsWith("/challenge") ? CHALLENGE_HTML : TRENDING_HTML);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it("extracts ranked, de-duplicated pair addresses from a client-rendered page", { timeout: 60_000 }, async () => {
    const r = await fetchBrowserTrending({ url: `${base}/`, timeoutMs: 20_000 });
    assert.equal(r.status, "ok", r.message);
    assert.deepEqual(
      r.pairs.map((p) => [p.rank, p.chainId, p.pairAddress]),
      [[1, "solana", P1], [2, "base", E1], [3, "solana", P2], [4, "solana", P3]],
    );
    assert.ok(r.browser);
  });

  it("honours the limit", { timeout: 60_000 }, async () => {
    const r = await fetchBrowserTrending({ url: `${base}/`, limit: 3, timeoutMs: 20_000 });
    assert.equal(r.pairs.length, 3);
  });

  it("reports `blocked` for a verification interstitial instead of hanging or bypassing it", { timeout: 60_000 }, async () => {
    const started = Date.now();
    const r = await fetchBrowserTrending({ url: `${base}/challenge`, timeoutMs: 6_000 });
    assert.equal(r.status, "blocked", r.message);
    assert.deepEqual(r.pairs, []);
    assert.ok(Date.now() - started < 20_000, "must give up within its budget");
  });

  it("reports `error` (not a crash) for an unreachable page", { timeout: 60_000 }, async () => {
    const r = await fetchBrowserTrending({ url: "http://127.0.0.1:9/", timeoutMs: 5_000 });
    assert.equal(r.status, "error");
  });
});

describe("browser trending against live dexscreener.com", { skip: skipLive }, () => {
  it("returns a well-formed result: ranked pairs, or a graceful `blocked`/`empty` status", { timeout: 90_000 }, async (t) => {
    const r = await fetchBrowserTrending({ timeoutMs: 40_000 });
    t.diagnostic(`live trending status=${r.status}: ${r.message}`);
    console.error(`[live trending] status=${r.status} pairs=${r.pairs.length} :: ${r.message}`);
    assert.ok(["ok", "blocked", "empty", "error"].includes(r.status), r.status);
    if (r.status === "ok") {
      assert.ok(r.pairs.length >= 3);
      r.pairs.forEach((p, i) => {
        assert.equal(p.rank, i + 1);
        assert.match(p.chainId, /^[a-z0-9-]+$/);
      });
    } else {
      assert.deepEqual(r.pairs, []);
      assert.ok(r.message.length > 20);
    }
  });
});
