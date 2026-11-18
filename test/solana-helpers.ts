import { generateKeyPairSync } from "node:crypto";
import { base58Encode } from "../mcp-server/src/trading/solana.js";

/** Generates a Solana-style keypair: 64-byte secret = seed || public key. */
export function newKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).subarray(-32);
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  const secret = Buffer.concat([seed, pub]);
  return { secret, secretBase58: base58Encode(secret), secretJson: JSON.stringify([...secret]), pub, pubBase58: base58Encode(pub), publicKey };
}

export const shortvec = (n: number) => Buffer.from([n]); // all test values < 128

/** Builds an unsigned transaction: shortvec(sigs) + zeroed signatures + message. */
export function fakeTx(keys: Buffer[], opts: { versioned?: boolean; numRequired?: number } = {}): { b64: string; message: Buffer } {
  const versioned = opts.versioned ?? true;
  const numRequired = opts.numRequired ?? 1;
  const message = Buffer.concat([
    versioned ? Buffer.from([0x80]) : Buffer.alloc(0),
    Buffer.from([numRequired, 0, 1]),
    shortvec(keys.length),
    ...keys,
    Buffer.alloc(32, 7), // recent blockhash
    shortvec(0), // no instructions
    versioned ? shortvec(0) : Buffer.alloc(0), // no address table lookups
  ]);
  const tx = Buffer.concat([shortvec(numRequired), Buffer.alloc(64 * numRequired), message]);
  return { b64: tx.toString("base64"), message };
}

