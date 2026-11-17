import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { verifySvg } from "../../scripts/verify-svg.mjs";

const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", process.env.CHROME_PATH, process.env.DEX_ALPHA_CHROME_PATH].find((p) => p && existsSync(p));
const hasPlaywright = existsSync(fileURLToPath(new URL("../../mcp-server/node_modules/playwright-core/package.json", import.meta.url)));
const skip = !chrome ? "no Chrome/Chromium found" : !hasPlaywright ? "playwright-core is not installed" : undefined;

describe("assets/architecture.svg rendered in headless Chrome", { skip }, () => {
  it("has zero clipped text, zero overlapping labels and no partially overlapping boxes", { timeout: 60_000 }, async () => {
    const { issues, geometry } = await verifySvg(fileURLToPath(new URL("../../assets/architecture.svg", import.meta.url)));
    assert.deepEqual(issues, []);
    assert.equal(geometry.viewBox.w, 1000);
    assert.ok(geometry.texts.length > 40, "labels were actually measured");
  });
});
