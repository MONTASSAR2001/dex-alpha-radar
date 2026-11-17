/** Shared domain types for dex-alpha-radar. */

export interface DexLink {
  type?: string;
  label?: string;
  url: string;
}

/** Entry returned by token-boosts / token-profiles / community-takeovers endpoints. */
export interface DexTokenSignal {
  url?: string;
  chainId: string;
  tokenAddress: string;
  amount?: number;
  totalAmount?: number;
  icon?: string;
  header?: string;
  description?: string;
  links?: DexLink[];
  claimDate?: string;
}

export interface TxnCounts {
  buys: number;
  sells: number;
}

export interface DexPair {
  chainId: string;
  dexId?: string;
  url?: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken?: { address: string; name: string; symbol: string };
  /** Exact string from the API. Never reformat it (tiny prices overflow into 1e-7 notation). */
  priceUsd?: string;
  priceNative?: string;
  txns?: Partial<Record<"m5" | "h1" | "h6" | "h24", TxnCounts>>;
  volume?: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  priceChange?: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { label?: string; url: string }[];
    socials?: { type: string; url: string }[];
  };
  boosts?: { active?: number };
}

export type SecurityStatus = "SAFE" | "WARNING" | "DANGER" | "UNVERIFIED";

export interface SecurityReport {
  status: SecurityStatus;
  chainId: string;
  address: string;
  source: "rugcheck" | "goplus" | "none";
  /** Human-readable one-line verdict. */
  verdict: string;
  /** Raw risk flags / reasons, human readable. */
  flags: string[];
  /** RugCheck normalised risk score (0 = safest, 100 = riskiest). */
  riskScore?: number;
  mintAuthorityActive?: boolean;
  freezeAuthorityActive?: boolean;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  topHolderPct?: number;
  top10HolderPct?: number;
  lpLockedPct?: number;
  isHoneypot?: boolean;
  cannotSellAll?: boolean;
  ownerChangeBalance?: boolean;
  isOpenSource?: boolean;
  /** Tax as a fraction (0.05 = 5%). */
  buyTax?: number;
  sellTax?: number;
}

export interface Catalysts {
  boosted: boolean;
  boostAmount?: number;
  cto: boolean;
}

export interface ScoreBreakdown {
  liquidity: number;
  pressure: number;
  velocity: number;
  social: number;
  /** Negative: anti-wash-trading / bot-volume penalty (0 to -20). */
  manipulationPenalty: number;
  securityAdjustment: number;
}

export interface AlphaScore {
  /** Final score, 0-100. */
  alphaScore: number;
  rejected: boolean;
  breakdown: ScoreBreakdown;
  reasons: string[];
  /** Human-readable risk warnings (bot volume, concentration, unverified contract...). */
  warnings: string[];
}
