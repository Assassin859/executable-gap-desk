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

export interface ExecRequest {
  symbol: string;
  usd: number;
  live: boolean;
}

/** Live needs `live: true` plus the literal confirmation "yes" the user typed after seeing the dry run. */
export function parseExecRequest(body: unknown, maxUsd: number): { ok: true; req: ExecRequest } | { ok: false; error: string } {
  const b = (body ?? {}) as { symbol?: unknown; usd?: unknown; live?: unknown; confirm?: unknown };
  if (typeof b.symbol !== "string" || !/^[A-Za-z0-9.]{1,16}$/.test(b.symbol)) return { ok: false, error: "symbol must be a venue symbol such as NVDAB." };
  if (typeof b.usd !== "number" || !Number.isFinite(b.usd) || b.usd <= 0 || b.usd > maxUsd) return { ok: false, error: `usd must be a number above 0 and at most ${maxUsd}.` };
  const live = b.live === true;
  if (live && b.confirm !== "yes") return { ok: false, error: 'A live broadcast needs confirm: "yes".' };
  return { ok: true, req: { symbol: b.symbol, usd: b.usd, live } };
}
