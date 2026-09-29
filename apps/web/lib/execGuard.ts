export type GuardResult = { ok: true } | { ok: false; status: 403 | 404; error: string };

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_IP = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;

/**
 * Execution signs with the Agentic Wallet on this machine, so the endpoint only exists when
 * EXECUTE_MODE=local, never on Vercel, and only for requests addressed to localhost.
 */
export function execGuard(env: { EXECUTE_MODE?: string; VERCEL?: string }, headers: { host: string | null; forwardedFor: string | null }): GuardResult {
  if (env.EXECUTE_MODE !== "local" || env.VERCEL) return { ok: false, status: 404, error: "Not found." };
  if (!headers.host || !LOCAL_HOST.test(headers.host)) return { ok: false, status: 403, error: "Execution only answers requests to localhost." };
  const fwd = headers.forwardedFor?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (fwd.some((ip) => !LOCAL_IP.test(ip))) return { ok: false, status: 403, error: "Execution only answers local requests." };
  return { ok: true };
}

export type ExecSide = "buy" | "sell";
export type ExecRoute = "contract-call" | "market-order";

export interface ExecRequest {
  symbol: string;
  /** Buy: USDT to spend. Sell: USD value to sell (absent with `all`). */
  usd: number | null;
  live: boolean;
  side: ExecSide;
  via: ExecRoute;
  /** Sell only: the whole on-chain balance. */
  all: boolean;
}

/**
 * Live needs `live: true` plus the literal confirmation "yes" the user typed after seeing the dry run.
 * Sells go through the Agentic Wallet market order and are sized by `usd` or `all`.
 */
export function parseExecRequest(body: unknown, maxUsd: number): { ok: true; req: ExecRequest } | { ok: false; error: string } {
  const b = (body ?? {}) as { symbol?: unknown; usd?: unknown; live?: unknown; confirm?: unknown; side?: unknown; via?: unknown; all?: unknown };
  if (typeof b.symbol !== "string" || !/^[A-Za-z0-9.]{1,16}$/.test(b.symbol)) return { ok: false, error: "symbol must be a venue symbol such as NVDAB." };
  const side = b.side ?? "buy";
  if (side !== "buy" && side !== "sell") return { ok: false, error: 'side must be "buy" or "sell".' };
  const via = b.via ?? "contract-call";
  if (via !== "contract-call" && via !== "market-order") return { ok: false, error: 'via must be "contract-call" or "market-order".' };
  if (side === "sell" && via !== "market-order") return { ok: false, error: 'Sells go through the Agentic Wallet: use via "market-order".' };
  const all = b.all === true;
  if (all && side !== "sell") return { ok: false, error: "all is only for sells." };
  let usd: number | null = null;
  if (all) {
    if (b.usd !== undefined && b.usd !== null) return { ok: false, error: "Give usd or all, not both." };
  } else {
    if (typeof b.usd !== "number" || !Number.isFinite(b.usd) || b.usd <= 0 || b.usd > maxUsd) return { ok: false, error: `usd must be a number above 0 and at most ${maxUsd}.` };
    usd = b.usd;
  }
  const live = b.live === true;
  if (live && b.confirm !== "yes") return { ok: false, error: 'A live broadcast needs confirm: "yes".' };
  return { ok: true, req: { symbol: b.symbol, usd, live, side, via, all } };
}
