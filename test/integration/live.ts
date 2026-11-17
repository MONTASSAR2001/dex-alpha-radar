/** Shared helpers for live (network) integration tests. */

/** Live tests are skipped (visibly) when SKIP_LIVE=1 or the network is unreachable. */
export async function probeNetwork(): Promise<string | undefined> {
  if (process.env.SKIP_LIVE === "1") return "SKIP_LIVE=1";
  try {
    const res = await fetch("https://api.dexscreener.com/token-boosts/latest/v1", { signal: AbortSignal.timeout(8000) });
    return res.status >= 500 ? `DexScreener returned HTTP ${res.status}` : undefined;
  } catch (e) {
    return `network unreachable (${e instanceof Error ? e.message : String(e)})`;
  }
}
