import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyGoPlus, classifyRugCheck, SecurityAuditor } from "../../mcp-server/src/security.js";
import { fakeTime, mockFetch } from "../helpers.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const EVM = "0x4200000000000000000000000000000000000006";

const meta = { name: "Mutable metadata", value: "", description: "", score: 100, level: "warn" };

describe("RugCheck classification", () => {
  it("SAFE below normalised 21 with revoked authorities", () => {
    const r = classifyRugCheck(MINT, { score_normalised: 7, risks: [meta] }, { mintAuthority: null, freezeAuthority: null, topHolders: [{ pct: 10.4 }, { pct: 9.5 }] });
    assert.equal(r.status, "SAFE");
    assert.equal(r.riskScore, 7);
    assert.equal(r.mintAuthorityActive, false);
    assert.equal(r.freezeAuthorityActive, false);
    assert.equal(r.topHolderPct, 10.4);
    assert.equal(r.top10HolderPct, 19.9);
  });

  it("boundary: 20 is SAFE, 21 and 40 are WARNING, 41 is DANGER", () => {
    const s = (n: number) => classifyRugCheck(MINT, { score_normalised: n, risks: [] }).status;
    assert.equal(s(20), "SAFE");
    assert.equal(s(20.9), "SAFE");
    assert.equal(s(21), "WARNING");
    assert.equal(s(40), "WARNING");
    assert.equal(s(41), "DANGER");
  });

  it("an active mint authority forces DANGER even with a low score", () => {
    const r = classifyRugCheck(MINT, { score_normalised: 2, risks: [] }, { mintAuthority: "Auth111111111111111111111111111111111111111", freezeAuthority: null });
    assert.equal(r.status, "DANGER");
    assert.equal(r.mintAuthorityActive, true);
    assert.match(r.flags[0]!, /Mint authority is ACTIVE/);
  });

  it("an active freeze authority forces DANGER", () => {
    const r = classifyRugCheck(MINT, { score_normalised: 2, risks: [] }, { mintAuthority: null, freezeAuthority: "Frz11111111111111111111111111111111111111111" });
    assert.equal(r.status, "DANGER");
    assert.equal(r.freezeAuthorityActive, true);
  });

  it("infers authorities from risk names when only the summary is available", () => {
    const r = classifyRugCheck(MINT, { score_normalised: 5, risks: [{ name: "Freeze Authority still enabled", level: "danger" }] });
    assert.equal(r.freezeAuthorityActive, true);
    assert.equal(r.mintAuthorityActive, false);
    assert.equal(r.status, "DANGER");
  });

  it("treats the system program as a revoked authority and honours rugged=true", () => {
    const revoked = classifyRugCheck(MINT, { score_normalised: 1 }, { mintAuthority: "11111111111111111111111111111111", freezeAuthority: null });
    assert.equal(revoked.status, "SAFE");
    const rugged = classifyRugCheck(MINT, { score_normalised: 1 }, { rugged: true });
    assert.equal(rugged.status, "DANGER");
  });

  it("returns UNVERIFIED (never SAFE) when no score is present", () => {
    assert.equal(classifyRugCheck(MINT, {}).status, "UNVERIFIED");
    assert.equal(classifyRugCheck(MINT, null, null).status, "UNVERIFIED");
  });

  it("falls back to the raw score when no normalised score exists", () => {
    const r = classifyRugCheck(MINT, { score: 55 });
    assert.equal(r.status, "DANGER");
    assert.ok(r.flags.some((f) => /raw score/.test(f)));
  });

  it("reads authorities nested under report.token", () => {
    const r = classifyRugCheck(MINT, { score_normalised: 3 }, { token: { mintAuthority: "X".repeat(44), freezeAuthority: null } });
    assert.equal(r.mintAuthorityActive, true);
  });
});

describe("GoPlus classification", () => {
  const clean = { is_honeypot: "0", buy_tax: "0", sell_tax: "0", cannot_sell_all: "0", owner_change_balance: "0", is_open_source: "1" };

  it("SAFE for a clean contract", () => {
    const r = classifyGoPlus("base", EVM, clean);
    assert.equal(r.status, "SAFE");
    assert.equal(r.buyTax, 0);
    assert.equal(r.isOpenSource, true);
  });

  it("DANGER for honeypot, cannot_sell_all and owner_change_balance", () => {
    assert.equal(classifyGoPlus("bsc", EVM, { ...clean, is_honeypot: "1" }).status, "DANGER");
    assert.equal(classifyGoPlus("bsc", EVM, { ...clean, cannot_sell_all: "1" }).status, "DANGER");
    assert.equal(classifyGoPlus("bsc", EVM, { ...clean, owner_change_balance: "1" }).status, "DANGER");
  });

  it("classifies taxes: >10% WARNING, >30% DANGER", () => {
    const r = classifyGoPlus("ethereum", EVM, { ...clean, buy_tax: "0.05", sell_tax: "0.12" });
    assert.equal(r.status, "WARNING");
    assert.equal(r.sellTax, 0.12);
    assert.match(r.verdict, /sell tax 12%/);
    assert.equal(classifyGoPlus("ethereum", EVM, { ...clean, sell_tax: "0.9" }).status, "DANGER");
  });

  it("WARNING for closed-source contracts and missing tax data", () => {
    assert.equal(classifyGoPlus("base", EVM, { ...clean, is_open_source: "0" }).status, "WARNING");
    assert.equal(classifyGoPlus("base", EVM, { is_honeypot: "0", cannot_sell_all: "0", owner_change_balance: "0", is_open_source: "1" }).status, "WARNING");
  });

  it("UNVERIFIED when GoPlus has no data or no honeypot verdict", () => {
    assert.equal(classifyGoPlus("base", EVM, undefined).status, "UNVERIFIED");
    assert.equal(classifyGoPlus("base", EVM, {}).status, "UNVERIFIED");
    assert.equal(classifyGoPlus("base", EVM, { buy_tax: "0" }).status, "UNVERIFIED");
  });
});

describe("SecurityAuditor (mocked network)", () => {
  function auditor(handler: Parameters<typeof mockFetch>[0]) {
    const clock = fakeTime();
    const { fn, calls } = mockFetch(handler);
    return { a: new SecurityAuditor({ fetchImpl: fn, now: clock.now, sleep: clock.sleep, baseDelayMs: 10 }), calls, clock };
  }
  const summary = { score: 101, score_normalised: 7, risks: [meta], lpLockedPct: 19.4 };

  it("Solana: calls the RugCheck summary endpoint", async () => {
    const { a, calls } = auditor(() => ({ body: summary }));
    const r = await a.audit("solana", MINT);
    assert.equal(r.status, "SAFE");
    assert.deepEqual(calls, [`https://api.rugcheck.xyz/v1/tokens/${MINT}/report/summary`]);
  });

  it("Solana deep: adds the full report for authorities and holders", async () => {
    const { a, calls } = auditor((u) => (u.endsWith("/summary") ? { body: summary } : { body: { mintAuthority: null, freezeAuthority: null, topHolders: [{ pct: 33 }] } }));
    const r = await a.audit("solana", MINT, { deep: true });
    assert.equal(calls.length, 2);
    assert.equal(r.topHolderPct, 33);
    assert.equal(r.mintAuthority, null);
    assert.ok(r.flags.some((f) => /Top holder owns 33%/.test(f)));
  });

  it("Solana: falls back to the full report when the summary fails", async () => {
    const { a, calls } = auditor((u) => (u.endsWith("/summary") ? { status: 404 } : { body: { score_normalised: 55, mintAuthority: null, freezeAuthority: null, risks: [] } }));
    const r = await a.audit("solana", MINT);
    assert.equal(r.status, "DANGER");
    assert.ok(calls[1]!.endsWith("/report"));
  });

  it("EVM: calls GoPlus with the numeric chain id and lowercase address", async () => {
    const { a, calls } = auditor((u) => ({ body: { code: 1, result: { [EVM]: { is_honeypot: "0", buy_tax: "0", sell_tax: "0", cannot_sell_all: "0", owner_change_balance: "0", is_open_source: "1" } } } }));
    const r = await a.audit("base", EVM.toUpperCase().replace("0X", "0x"));
    assert.equal(r.status, "SAFE");
    assert.equal(calls[0], `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${EVM}`);
    for (const [chain, id] of [["ethereum", 1], ["bsc", 56], ["arbitrum", 42161], ["polygon", 137]] as const) {
      await a.audit(chain, EVM);
      assert.ok(calls.at(-1)!.includes(`/token_security/${id}?`), chain);
    }
  });

  it("fail-closed: persistent 5xx -> UNVERIFIED, never SAFE", async () => {
    const sol = auditor(() => ({ status: 500 }));
    assert.equal((await sol.a.audit("solana", MINT)).status, "UNVERIFIED");
    const evm = auditor(() => ({ status: 500 }));
    assert.equal((await evm.a.audit("base", EVM)).status, "UNVERIFIED");
  });

  it("fail-closed: timeouts / network errors -> UNVERIFIED", async () => {
    const t = auditor(() => ({ throws: new DOMException("The operation was aborted due to timeout", "TimeoutError") }));
    const r = await t.a.audit("base", EVM);
    assert.equal(r.status, "UNVERIFIED");
    assert.match(r.verdict, /unsafe until verified/);
  });

  it("fail-closed: empty GoPlus result, API error code, malformed bodies", async () => {
    assert.equal((await auditor(() => ({ body: { code: 1, result: {} } })).a.audit("base", EVM)).status, "UNVERIFIED");
    assert.equal((await auditor(() => ({ body: { code: 2007, message: "bad", result: null } })).a.audit("base", EVM)).status, "UNVERIFIED");
    assert.equal((await auditor(() => ({ body: [] })).a.audit("solana", MINT)).status, "UNVERIFIED");
    assert.equal((await auditor(() => ({ body: {} })).a.audit("solana", MINT)).status, "UNVERIFIED");
  });

  it("fail-closed: unsupported chains and malformed addresses make no network calls", async () => {
    const { a, calls } = auditor(() => ({ body: {} }));
    assert.equal((await a.audit("sui", "0x" + "1".repeat(64))).status, "UNVERIFIED");
    assert.equal((await a.audit("base", "not-an-address")).status, "UNVERIFIED");
    assert.equal((await a.audit("solana", "short")).status, "UNVERIFIED");
    assert.equal(calls.length, 0);
  });

  it("caches verified results but never caches UNVERIFIED failures", async () => {
    const ok = auditor(() => ({ body: summary }));
    await ok.a.audit("solana", MINT);
    await ok.a.audit("solana", MINT);
    assert.equal(ok.calls.length, 1);
    const flaky = auditor((_u, n) => (n <= 4 ? { status: 500 } : { body: summary }));
    assert.equal((await flaky.a.audit("solana", MINT)).status, "UNVERIFIED");
    assert.equal((await flaky.a.audit("solana", MINT)).status, "SAFE");
  });
});
