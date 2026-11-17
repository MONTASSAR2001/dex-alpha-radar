import { realSleep, type Sleeper } from "./limiter.js";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  sleep?: Sleeper;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Retries after the first attempt (429 / 5xx / network errors only). */
  retries?: number;
  /** First backoff delay; doubles each retry. */
  baseDelayMs?: number;
  headers?: Record<string, string>;
}

const MAX_RETRY_AFTER_MS = 15_000;

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}

/**
 * GET + JSON with exponential backoff on HTTP 429 / 5xx / network failures.
 * 4xx responses other than 429 are returned as an HttpError immediately.
 */
export async function fetchJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let waitMs = base * 2 ** attempt + Math.floor(Math.random() * (base / 2));
    try {
      const res = await doFetch(url, {
        headers: { accept: "application/json", "user-agent": "dex-alpha-radar/1.0", ...opts.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch {
          throw new HttpError("Response was not valid JSON", res.status, url);
        }
      }
      const err = new HttpError(`HTTP ${res.status} ${res.statusText}`.trim(), res.status, url);
      if (res.status !== 429 && res.status < 500) throw err; // not retryable
      lastError = err;
      waitMs = Math.max(waitMs, retryAfterMs(res) ?? 0);
    } catch (e) {
      if (e instanceof HttpError && e.status !== undefined && e.status !== 429 && e.status < 500) throw e;
      if (e instanceof HttpError && e.message.startsWith("Response was not valid JSON")) throw e;
      lastError = e;
    }
    if (attempt < retries) await sleep(waitMs);
  }
  if (lastError instanceof HttpError) throw lastError;
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new HttpError(`Request failed after ${retries + 1} attempts: ${msg}`, undefined, url);
}
