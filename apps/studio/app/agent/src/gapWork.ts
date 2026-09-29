/**
 * The Executable Gap Desk work hook: no LLM, no signing, no keys.
 *
 * Every face (x402, MCP, A2A delivery) turns its request into a prompt and
 * calls `runWork`. This hook pulls one ticker out of that prompt and returns
 * the desk's public gate JSON from GAP_DESK_URL/api/check/{ticker}: GO,
 * CAUTION or BLOCK per venue with reasons and the best venue.
 */

export const GAP_DESK_URL = (
  process.env.GAP_DESK_URL ?? "https://executable-gap-desk.vercel.app"
).replace(/\/+$/, "");

const TICKER_RE = /^[A-Z0-9.]{1,12}$/;
const NOT_TICKERS = new Set(["JOB", "CONTEXT", "JSON", "USD", "USDT", "API", "GO", "BLOCK", "CAUTION", "BSC", "BNB", "U"]);
const TIMEOUT_MS = 45_000;

/** `{"ticker":"NVDA"}`, a bare `NVDA`, or the first capitalised ticker-like word in free text. */
export function tickerFrom(prompt: string): string | null {
  const text = prompt.trim();
  const keyed = /"ticker"\s*:\s*"([A-Za-z0-9.]{1,12})"/.exec(text);
  if (keyed?.[1]) return keyed[1].toUpperCase();
  if (TICKER_RE.test(text.toUpperCase()) && text.length <= 12) return text.toUpperCase();
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?\b/g)) {
    if (!NOT_TICKERS.has(m[0])) return m[0];
  }
  return null;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function gateWork(prompt: string, opts: { abortSignal?: AbortSignal; fetch?: Fetch } = {}): Promise<string> {
  const ticker = tickerFrom(prompt);
  if (!ticker) {
    return JSON.stringify({ error: "No ticker found. Send a US stock ticker, e.g. NVDA, or {\"ticker\":\"NVDA\"}." });
  }
  const signal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
  const url = `${GAP_DESK_URL}/api/check/${encodeURIComponent(ticker)}`;
  const res = await (opts.fetch ?? fetch)(url, { signal, headers: { accept: "application/json", "user-agent": "gapdeskstudio-agent" } });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || body === null) {
    return JSON.stringify({ ticker, error: (body?.error as string | undefined) ?? `gate API answered HTTP ${res.status}`, source: url });
  }
  return JSON.stringify({ source: url, ...body });
}
