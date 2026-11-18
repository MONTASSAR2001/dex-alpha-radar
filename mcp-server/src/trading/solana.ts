/**
 * Minimal Solana primitives with zero extra dependencies:
 *  - base58, shortvec
 *  - ed25519 key handling and versioned-transaction signing via node:crypto
 *  - a tiny JSON-RPC client (token decimals/balances, simulate, send, confirm)
 *
 * Secret-key hygiene: a parsed key lives only inside a `Signer` closure. It has no
 * toString/toJSON, is never returned from a tool and never appears in error messages.
 */
import { createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { fetchJson, HttpError, type HttpOptions } from "../http.js";
import { realSleep, type Sleeper } from "../limiter.js";

// ---------------------------------------------------------------------------
// base58 / shortvec
// ---------------------------------------------------------------------------

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join("");
}

export function base58Decode(str: string): Uint8Array {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const v = INDEX.get(str[i]!);
    if (v === undefined) throw new Error("Invalid base58 character");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

export function isValidPublicKey(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

export function readShortVec(buf: Uint8Array, offset: number): { value: number; size: number } {
  let value = 0;
  let size = 0;
  for (;;) {
    const b = buf[offset + size];
    if (b === undefined) throw new Error("Truncated shortvec");
    value |= (b & 0x7f) << (7 * size);
    size++;
    if ((b & 0x80) === 0) break;
    if (size > 3) throw new Error("Invalid shortvec");
  }
  return { value, size };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface Signer {
  /** Base58 public key (safe to show). */
  readonly publicKey: string;
  /** Signs a base64 (versioned or legacy) transaction; returns the signed base64 and the base58 signature. */
  signTransaction(txBase64: string): { signedBase64: string; signature: string };
}

/**
 * Builds a signer from a Solana secret key: a base58 string (Phantom export) or a JSON byte
 * array (Solana CLI keypair file). Throws a generic error on any problem, never echoing the input.
 */
export function createSigner(secret: string): Signer {
  let bytes: Uint8Array;
  try {
    const s = secret.trim();
    bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s) as number[]) : base58Decode(s);
  } catch {
    throw new Error("SOLANA_BURNER_PRIVATE_KEY is not a valid base58 or JSON-array secret key");
  }
  if (bytes.length !== 64) throw new Error("SOLANA_BURNER_PRIVATE_KEY must decode to a 64-byte Solana secret key");
  const seed = Buffer.from(bytes.subarray(0, 32));
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" })).subarray(-32);
  if (!Buffer.from(bytes.subarray(32)).equals(pub)) throw new Error("SOLANA_BURNER_PRIVATE_KEY is inconsistent (public half does not match the seed)");
  const publicKey = base58Encode(pub);

  const signer: Signer = {
    publicKey,
    signTransaction(txBase64: string) {
      const raw = Buffer.from(txBase64, "base64");
      const { value: nSigs, size } = readShortVec(raw, 0);
      const sigStart = size;
      const msgStart = size + nSigs * 64;
      if (nSigs < 1 || msgStart >= raw.length) throw new Error("Malformed transaction");
      const msg = raw.subarray(msgStart);
      let o = (msg[0]! & 0x80) !== 0 ? 1 : 0; // versioned messages carry a version prefix byte
      const numRequired = msg[o]!;
      o += 3; // header: required signatures, readonly signed, readonly unsigned
      const { value: nKeys, size: ks } = readShortVec(msg, o);
      o += ks;
      if (numRequired !== nSigs || nKeys < numRequired) throw new Error("Malformed transaction header");
      const signers = Array.from({ length: numRequired }, (_, i) => base58Encode(msg.subarray(o + i * 32, o + (i + 1) * 32)));
      // Safety: only ever sign a transaction where our key is the sole required signer (fee payer).
      if (numRequired !== 1 || signers[0] !== publicKey) {
        throw new Error("Refusing to sign: the transaction's fee payer / required signers do not match the burner wallet");
      }
      const signature = edSign(null, msg, key);
      signature.copy(raw, sigStart);
      return { signedBase64: raw.toString("base64"), signature: base58Encode(signature) };
    },
  };
  Object.defineProperty(signer, "toJSON", { value: () => ({ publicKey }), enumerable: false });
  return signer;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

export interface SolanaRpcOptions extends HttpOptions {
  url?: string;
  sleep?: Sleeper;
}

export class SolanaRpc {
  private readonly url: string;
  private readonly http: HttpOptions;
  private readonly sleep: Sleeper;
  private id = 0;

  constructor(opts: SolanaRpcOptions = {}) {
    this.url = opts.url ?? DEFAULT_RPC_URL;
    this.sleep = opts.sleep ?? realSleep;
    this.http = { fetchImpl: opts.fetchImpl, sleep: opts.sleep, timeoutMs: opts.timeoutMs ?? 10_000, retries: opts.retries ?? 2, baseDelayMs: opts.baseDelayMs ?? 400 };
  }

  /** RPC URLs often embed API keys: errors never include the URL. */
  async call<T>(method: string, params: unknown[]): Promise<T> {
    let res: { result?: T; error?: { code?: number; message?: string } };
    try {
      res = await fetchJson(this.url, { ...this.http, method: "POST", body: { jsonrpc: "2.0", id: ++this.id, method, params } });
    } catch (e) {
      throw new Error(`Solana RPC ${method} failed: ${e instanceof HttpError ? (e.status ? `HTTP ${e.status}` : e.message) : e instanceof Error ? e.message : String(e)}`);
    }
    if (res.error) throw new Error(`Solana RPC ${method} error ${res.error.code ?? ""}: ${res.error.message ?? "unknown"}`);
    return res.result as T;
  }

  async getTokenDecimals(mint: string): Promise<number> {
    const r = await this.call<{ value?: { decimals?: number } }>("getTokenSupply", [mint]);
    const d = r?.value?.decimals;
    if (typeof d !== "number") throw new Error("Solana RPC getTokenSupply returned no decimals");
    return d;
  }

  /** Sum of the owner's token accounts for a mint, in raw units. */
  async getTokenBalanceRaw(owner: string, mint: string): Promise<{ raw: bigint; decimals?: number }> {
    const r = await this.call<{ value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } } } }[] }>("getTokenAccountsByOwner", [
      owner,
      { mint },
      { encoding: "jsonParsed" },
    ]);
    let raw = 0n;
    let decimals: number | undefined;
    for (const a of r?.value ?? []) {
      const t = a.account?.data?.parsed?.info?.tokenAmount;
      if (t?.amount && /^\d+$/.test(t.amount)) raw += BigInt(t.amount);
      decimals ??= t?.decimals;
    }
    return { raw, decimals };
  }

  async simulate(txBase64: string): Promise<{ err: unknown; logs: string[]; unitsConsumed?: number }> {
    const r = await this.call<{ value?: { err?: unknown; logs?: string[] | null; unitsConsumed?: number } }>("simulateTransaction", [
      txBase64,
      { encoding: "base64", sigVerify: false, commitment: "processed" },
    ]);
    return { err: r?.value?.err ?? null, logs: r?.value?.logs ?? [], unitsConsumed: r?.value?.unitsConsumed };
  }

  async send(txBase64: string): Promise<string> {
    return this.call<string>("sendTransaction", [txBase64, { encoding: "base64", skipPreflight: false, maxRetries: 3, preflightCommitment: "processed" }]);
  }

  /** One-shot status check. */
  async signatureStatus(signature: string): Promise<"confirmed" | "failed" | "pending"> {
    const r = await this.call<{ value?: ({ err?: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const s = r?.value?.[0];
    if (!s) return "pending";
    if (s.err) return "failed";
    return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "confirmed" : "pending";
  }

  /** Polls until the signature is confirmed/finalized, fails on-chain, or the timeout elapses. */
  async confirm(signature: string, timeoutMs = 45_000, pollMs = 1_500): Promise<{ confirmed: boolean; error?: unknown }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.call<{ value?: ({ err?: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
      const s = r?.value?.[0];
      if (s?.err) return { confirmed: false, error: s.err };
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return { confirmed: true };
      await this.sleep(pollMs);
    }
    return { confirmed: false };
  }
}

/** Replaces anything that looks like a secret key (long base58 / byte arrays) in a message. */
export function redactSecrets(message: string): string {
  return message.replace(/\[(?:\s*\d{1,3}\s*,){31,}\s*\d{1,3}\s*\]/g, "[REDACTED]").replace(/[1-9A-HJ-NP-Za-km-z]{80,}/g, "[REDACTED]");
}
