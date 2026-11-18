import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { describe, it } from "node:test";
import { base58Decode, base58Encode, createSigner, isValidPublicKey, readShortVec, redactSecrets, SolanaRpc } from "../../mcp-server/src/trading/solana.js";
import { fakeTime, mockFetch } from "../helpers.js";
import { fakeTx, newKeypair } from "../solana-helpers.js";

describe("base58 / shortvec", () => {
  it("round-trips, preserves leading zero bytes and rejects bad characters", () => {
    for (const bytes of [Buffer.from([0, 0, 1, 2, 3]), Buffer.alloc(32, 255), Buffer.from("hello world")]) {
      assert.deepEqual(Buffer.from(base58Decode(base58Encode(bytes))), bytes);
    }
    assert.equal(base58Encode(Buffer.from("hello world")), "StV1DL6CwTryKyV");
    assert.equal(base58Encode(Buffer.alloc(3)), "111");
    assert.throws(() => base58Decode("0OIl"), /Invalid base58/);
  });

  it("validates public keys", () => {
    assert.equal(isValidPublicKey("So11111111111111111111111111111111111111112"), true);
    assert.equal(isValidPublicKey("short"), false);
    assert.equal(isValidPublicKey("0".repeat(44)), false);
  });

  it("reads shortvec lengths", () => {
    assert.deepEqual(readShortVec(Buffer.from([5]), 0), { value: 5, size: 1 });
    assert.deepEqual(readShortVec(Buffer.from([0x80, 0x01]), 0), { value: 128, size: 2 });
    assert.throws(() => readShortVec(Buffer.from([0x80]), 0), /Truncated/);
  });
});

describe("createSigner", () => {
  it("accepts base58 and JSON-array secret keys and derives the same public key", () => {
    const k = newKeypair();
    assert.equal(createSigner(k.secretBase58).publicKey, k.pubBase58);
    assert.equal(createSigner(k.secretJson).publicKey, k.pubBase58);
  });

  it("rejects malformed or inconsistent keys without echoing them", () => {
    const k = newKeypair();
    const other = newKeypair();
    const mismatched = base58Encode(Buffer.concat([k.secret.subarray(0, 32), other.pub]));
    for (const bad of ["not-a-key", "[1,2,3]", base58Encode(Buffer.alloc(32, 9)), mismatched]) {
      try {
        createSigner(bad);
        assert.fail("should have thrown");
      } catch (e) {
        const msg = (e as Error).message;
        assert.match(msg, /SOLANA_BURNER_PRIVATE_KEY/);
        assert.ok(!msg.includes(bad) || bad.length < 12, "error must not echo the secret");
      }
    }
  });

  it("never serialises the secret", () => {
    const k = newKeypair();
    const s = createSigner(k.secretBase58);
    const dumped = JSON.stringify(s) + String(s) + JSON.stringify(Object.getOwnPropertyNames(s));
    assert.ok(!dumped.includes(k.secretBase58));
    assert.ok(!dumped.includes(k.secret.subarray(0, 32).toString("hex")));
    assert.deepEqual(JSON.parse(JSON.stringify(s)), { publicKey: k.pubBase58 });
  });

  it("produces a valid ed25519 signature over the message (versioned and legacy)", () => {
    const k = newKeypair();
    const signer = createSigner(k.secretBase58);
    for (const versioned of [true, false]) {
      const { b64, message } = fakeTx([k.pub, Buffer.alloc(32, 3), Buffer.alloc(32, 4)], { versioned });
      const { signedBase64, signature } = signer.signTransaction(b64);
      const raw = Buffer.from(signedBase64, "base64");
      const sig = raw.subarray(1, 65);
      assert.equal(base58Encode(sig), signature);
      assert.ok(verify(null, message, k.publicKey, sig), `signature verifies (versioned=${versioned})`);
      assert.deepEqual(raw.subarray(65), message, "message is untouched");
    }
  });

  it("refuses to sign when the burner is not the fee payer", () => {
    const k = newKeypair();
    const signer = createSigner(k.secretBase58);
    const { b64 } = fakeTx([Buffer.alloc(32, 9), k.pub]);
    assert.throws(() => signer.signTransaction(b64), /Refusing to sign/);
  });

  it("refuses to sign transactions that need other signers", () => {
    const k = newKeypair();
    const signer = createSigner(k.secretBase58);
    const { b64 } = fakeTx([k.pub, Buffer.alloc(32, 9), Buffer.alloc(32, 8)], { numRequired: 2 });
    assert.throws(() => signer.signTransaction(b64), /Refusing to sign/);
  });

  it("rejects malformed transactions", () => {
    const signer = createSigner(newKeypair().secretBase58);
    assert.throws(() => signer.signTransaction(Buffer.from([1]).toString("base64")), /Malformed/);
    assert.throws(() => signer.signTransaction(""), /Truncated|Malformed/);
  });
});

describe("redactSecrets", () => {
  it("masks long base58 strings and 64-byte arrays", () => {
    const k = newKeypair();
    const msg = redactSecrets(`failed with ${k.secretBase58} and ${k.secretJson} ok`);
    assert.ok(!msg.includes(k.secretBase58));
    assert.ok(!msg.includes(k.secretJson));
    assert.match(msg, /\[REDACTED\].*\[REDACTED\].*ok/);
    assert.equal(redactSecrets("plain message with So11111111111111111111111111111111111111112"), "plain message with So11111111111111111111111111111111111111112");
  });
});

describe("SolanaRpc", () => {
  function rpc(handler: Parameters<typeof mockFetch>[0], url = "https://rpc.example/?api-key=SECRETKEY123") {
    const clock = fakeTime();
    const { fn, calls, bodies } = mockFetch(handler);
    return { rpc: new SolanaRpc({ url, fetchImpl: fn, sleep: clock.sleep, retries: 0 }), calls, bodies, clock };
  }
  const ok = (result: unknown) => ({ body: { jsonrpc: "2.0", id: 1, result } });

  it("reads token decimals and sums token accounts", async () => {
    const { rpc: r, bodies } = rpc((_u, _n, b) => (b.method === "getTokenSupply" ? ok({ value: { decimals: 6 } }) : ok({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: "100", decimals: 6 } } } } } }, { account: { data: { parsed: { info: { tokenAmount: { amount: "250", decimals: 6 } } } } } }] })));
    assert.equal(await r.getTokenDecimals("MINT"), 6);
    assert.deepEqual(await r.getTokenBalanceRaw("OWNER", "MINT"), { raw: 350n, decimals: 6 });
    assert.equal((bodies[1] as { method: string }).method, "getTokenAccountsByOwner");
  });

  it("simulates, sends and confirms", async () => {
    let polls = 0;
    const { rpc: r } = rpc((_u, _n, b) => {
      if (b.method === "simulateTransaction") return ok({ value: { err: null, logs: ["ok"], unitsConsumed: 5 } });
      if (b.method === "sendTransaction") return ok("SIG123");
      polls++;
      return ok({ value: [polls < 3 ? null : { confirmationStatus: "confirmed", err: null }] });
    });
    assert.deepEqual(await r.simulate("tx"), { err: null, logs: ["ok"], unitsConsumed: 5 });
    assert.equal(await r.send("tx"), "SIG123");
    assert.deepEqual(await r.confirm("SIG123", 60_000, 10), { confirmed: true });
    assert.equal(polls, 3);
  });

  it("reports on-chain failures and pending statuses", async () => {
    const failed = rpc(() => ok({ value: [{ err: { InstructionError: [0, "Custom"] } }] }));
    assert.equal((await failed.rpc.confirm("S", 1000, 10)).confirmed, false);
    assert.equal(await failed.rpc.signatureStatus("S"), "failed");
    const pending = rpc(() => ok({ value: [null] }));
    assert.equal(await pending.rpc.signatureStatus("S"), "pending");
  });

  it("surfaces RPC errors without leaking the URL (which may contain an API key)", async () => {
    const e1 = rpc(() => ({ body: { jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed" } } }));
    await assert.rejects(e1.rpc.send("tx"), (e: Error) => /-32002/.test(e.message) && !e.message.includes("SECRETKEY123"));
    const e2 = rpc(() => ({ status: 500 }));
    await assert.rejects(e2.rpc.getTokenDecimals("M"), (e: Error) => /HTTP 500/.test(e.message) && !e.message.includes("SECRETKEY123"));
  });
});
