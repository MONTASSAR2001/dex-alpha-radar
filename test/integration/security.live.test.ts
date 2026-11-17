import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SecurityAuditor } from "../../mcp-server/src/security.js";
import { probeNetwork } from "./live.js";

const skip = await probeNetwork();
const STATUSES = ["SAFE", "WARNING", "DANGER", "UNVERIFIED"];

describe("RugCheck live (Solana)", { skip }, () => {
  const auditor = new SecurityAuditor();
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  it("summary endpoint schema maps to a normalised risk score", async () => {
    const r = await auditor.audit("solana", BONK);
    assert.equal(r.source, "rugcheck");
    assert.notEqual(r.status, "UNVERIFIED", r.verdict);
    assert.ok(STATUSES.includes(r.status));
    assert.equal(typeof r.riskScore, "number");
    assert.ok(r.riskScore! >= 0 && r.riskScore! <= 100);
    assert.equal(typeof r.mintAuthorityActive, "boolean");
    assert.equal(typeof r.freezeAuthorityActive, "boolean");
  });

  it("deep audit exposes authorities and holder concentration from the full report", async () => {
    const r = await auditor.audit("solana", BONK, { deep: true });
    assert.notEqual(r.status, "UNVERIFIED", r.verdict);
    assert.equal(r.mintAuthority, null, "BONK mint authority is revoked");
    assert.equal(r.freezeAuthority, null);
    assert.equal(typeof r.topHolderPct, "number");
    assert.equal(typeof r.top10HolderPct, "number");
  });

  it("flags USDC's active freeze authority as DANGER", async () => {
    const r = await auditor.audit("solana", USDC, { deep: true });
    assert.equal(r.freezeAuthorityActive, true);
    assert.equal(r.status, "DANGER");
  });

  it("fails closed for an unknown mint", async () => {
    const r = await auditor.audit("solana", "11111111111111111111111111111112");
    assert.equal(r.status, "UNVERIFIED");
  });
});

describe("GoPlus live (EVM)", { skip }, () => {
  const auditor = new SecurityAuditor();
  const cases: [string, string][] = [
    ["base", "0x4200000000000000000000000000000000000006"], // WETH on Base
    ["ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"], // USDC
    ["bsc", "0x55d398326f99059fF775485246999027B3197955"], // USDT (BSC)
  ];

  for (const [chain, address] of cases) {
    it(`${chain}: token_security schema is classified (not UNVERIFIED)`, async () => {
      const r = await auditor.audit(chain, address);
      assert.equal(r.source, "goplus");
      assert.notEqual(r.status, "UNVERIFIED", r.verdict);
      assert.equal(typeof r.isHoneypot, "boolean");
      assert.equal(r.isHoneypot, false);
      assert.equal(typeof r.cannotSellAll === "boolean" || r.cannotSellAll === undefined, true);
      assert.ok(r.buyTax === undefined || (r.buyTax >= 0 && r.buyTax <= 1));
    });
  }

  it("fails closed for a non-existent contract", async () => {
    const r = await auditor.audit("base", "0x000000000000000000000000000000000000dEaD");
    assert.equal(r.status, "UNVERIFIED");
  });
});
