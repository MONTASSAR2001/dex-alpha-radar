/** Chain metadata and address helpers. */

/** DexScreener chainId -> numeric EVM chain id used by GoPlus. */
export const GOPLUS_CHAIN_IDS: Readonly<Record<string, number>> = {
  ethereum: 1,
  bsc: 56,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
};

export const SECURITY_SUPPORTED_EVM = Object.keys(GOPLUS_CHAIN_IDS);

/** EVM-style chains (case-insensitive hex addresses), incl. ones we cannot audit. */
const EVM_CHAINS = new Set([
  ...SECURITY_SUPPORTED_EVM,
  "optimism",
  "avalanche",
  "linea",
  "blast",
  "scroll",
  "zksync",
  "fantom",
  "cronos",
  "pulsechain",
  "sonic",
  "abstract",
  "unichain",
  "berachain",
  "hyperevm",
]);

export function normalizeChain(chain: string): string {
  const c = chain.trim().toLowerCase();
  if (c === "eth") return "ethereum";
  if (c === "bnb" || c === "bnbchain" || c === "bsc") return "bsc";
  if (c === "sol") return "solana";
  if (c === "arb") return "arbitrum";
  if (c === "matic") return "polygon";
  return c;
}

export function isEvmChain(chainId: string): boolean {
  return EVM_CHAINS.has(chainId.toLowerCase());
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function looksLikeEvmAddress(s: string): boolean {
  return EVM_ADDRESS.test(s.trim());
}

export function looksLikeSolanaAddress(s: string): boolean {
  return SOLANA_ADDRESS.test(s.trim());
}

export function looksLikeAddress(s: string): boolean {
  return looksLikeEvmAddress(s) || looksLikeSolanaAddress(s);
}

/** Canonical form for comparisons/dedupe: EVM addresses are case-insensitive, Solana's are not. */
export function normalizeAddress(chainId: string, address: string): string {
  const a = address.trim();
  return isEvmChain(chainId) || looksLikeEvmAddress(a) ? a.toLowerCase() : a;
}

export function tokenKey(chainId: string, address: string): string {
  return `${chainId.toLowerCase()}:${normalizeAddress(chainId, address)}`;
}
