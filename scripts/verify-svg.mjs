#!/usr/bin/env node
/**
 * Renders an SVG in headless Chrome (via playwright-core) and checks its geometry:
 *   1. every <text> lies inside the viewBox
 *   2. every <text> fits inside the smallest <rect> that contains it (with padding), so no clipping
 *   3. no two <text> bounding boxes overlap
 *   4. sibling <rect> boxes never partially overlap (they are either nested or disjoint)
 *
 * Usage: node scripts/verify-svg.mjs [assets/architecture.svg] [--screenshot out.png] [--padding 6]
 * Exits 1 when any check fails or no browser is available.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHROME_CANDIDATES = [
  process.env.DEX_ALPHA_CHROME_PATH,
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

/** Runs inside the page: returns text/rect geometry in SVG user units. */
function measure() {
  const svg = document.querySelector("svg");
  const vb = svg.viewBox.baseVal;
  const box = (el) => {
    const b = el.getBBox();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  const texts = [...svg.querySelectorAll("text")].map((el, i) => ({ i, label: el.textContent.trim().replace(/\s+/g, " "), ...box(el) }));
  const rects = [...svg.querySelectorAll("rect")].map((el, i) => ({ i, ...box(el) }));
  return { viewBox: { x: vb.x, y: vb.y, w: vb.width, h: vb.height }, texts, rects };
}

const contains = (outer, inner, pad = 0) =>
  inner.x >= outer.x + pad && inner.y >= outer.y + pad && inner.x + inner.w <= outer.x + outer.w - pad && inner.y + inner.h <= outer.y + outer.h - pad;

const overlap = (a, b, eps = 0.5) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > eps && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > eps;

const area = (r) => r.w * r.h;

/** Pure geometry analysis (unit-testable without a browser). */
export function analyzeGeometry({ viewBox, texts, rects }, { padding = 6 } = {}) {
  const issues = [];
  const vbBox = { x: viewBox.x, y: viewBox.y, w: viewBox.w, h: viewBox.h };
  // The two background rects span the whole canvas; they are not containers for fit checks.
  const containers = rects.filter((r) => area(r) < area(vbBox) * 0.98);

  for (const t of texts) {
    if (!contains(vbBox, t, 4)) issues.push(`text "${t.label}" is outside the viewBox (or within 4px of its edge)`);
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    const host = containers
      .filter((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h)
      .sort((a, b) => area(a) - area(b))[0];
    if (host && !contains(host, t, padding)) {
      issues.push(`text "${t.label}" (${t.w.toFixed(0)}x${t.h.toFixed(0)}) does not fit inside its box (${host.w.toFixed(0)}x${host.h.toFixed(0)}) with ${padding}px padding`);
    }
  }

  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (overlap(texts[i], texts[j])) issues.push(`text "${texts[i].label}" overlaps text "${texts[j].label}"`);
    }
  }

  for (let i = 0; i < containers.length; i++) {
    for (let j = i + 1; j < containers.length; j++) {
      const a = containers[i];
      const b = containers[j];
      if (overlap(a, b) && !contains(a, b) && !contains(b, a)) {
        issues.push(`boxes at (${a.x},${a.y}) ${a.w}x${a.h} and (${b.x},${b.y}) ${b.w}x${b.h} partially overlap`);
      }
    }
  }
  return issues;
}

export async function verifySvg(svgPath, { padding = 6, screenshot } = {}) {
  const require = createRequire(join(root, "mcp-server", "package.json"));
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed (run `npm run setup`).");
  }
  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error("No Chrome/Chromium found. Set DEX_ALPHA_CHROME_PATH.");

  const svg = readFileSync(svgPath, "utf8");
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : [],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><body style="margin:0;background:#fff">${svg}</body>`);
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.evaluate(measure);
    if (screenshot) await page.locator("svg").screenshot({ path: screenshot });
    const issues = analyzeGeometry(geometry, { padding });
    return { issues, geometry, browser: executablePath };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? join(root, "assets", "architecture.svg");
  try {
    const { issues, geometry, browser } = await verifySvg(resolve(file), { padding: Number(opt("--padding") ?? 6), screenshot: opt("--screenshot") });
    console.log(`Rendered ${file} in ${browser}`);
    console.log(`viewBox ${geometry.viewBox.w}x${geometry.viewBox.h}; ${geometry.texts.length} text labels, ${geometry.rects.length} boxes checked`);
    if (issues.length) {
      console.error(`FAILED: ${issues.length} layout issue(s)\n - ${issues.join("\n - ")}`);
      process.exit(1);
    }
    console.log("OK: no clipped text, no overlapping labels, no partially overlapping boxes.");
  } catch (e) {
    console.error(`verify-svg: ${e.message}`);
    process.exit(1);
  }
}
