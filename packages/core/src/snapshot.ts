import { DEFAULT_POLICY, evaluateTicker, type Policy, type TickerVerdict, type Verdict } from "./gate";
import { buildMatrix, type BuildMatrixOptions, type MatrixResult, type MatrixRow } from "./matrix";
import { getQuote, type ExecQuote, type QuoteOptions } from "./quotes";
import type { Venue } from "./registry";
import type { MarketSession } from "./session";

type QuoteFn = (venue: Venue, usd: number, opts: QuoteOptions) => Promise<ExecQuote>;

export interface GateRunOptions {
  usd?: number;
  /** Extra sizes quoted per venue for the impact rules, e.g. [100, 500]. */
  ladderSizes?: number[];
  policy?: Policy;
  wallet?: string;
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
  deps?: {
    buildMatrix?: (opts: BuildMatrixOptions) => Promise<MatrixResult>;
    getQuote?: QuoteFn;
  };
}

export interface TickerCheck extends TickerVerdict {
  rows: MatrixRow[];
  usd: number;
}

const venueOf = (r: MatrixRow): Venue => ({
  ticker: r.ticker,
  platform: r.platform,
  symbol: r.symbol,
  address: r.address,
  multiplier: r.multiplier ?? 1,
});

function groupRows(rows: MatrixRow[]): Map<string, MatrixRow[]> {
  const groups = new Map<string, MatrixRow[]>();
  for (const r of rows) groups.set(r.ticker, [...(groups.get(r.ticker) ?? []), r]);
  return groups;
}

/**
 * Quotes every venue in `rows` (through the shared 5 rps limiter inside getQuote), then gates each ticker.
 * Tickers listed on more venues are quoted first. A failing quote becomes a BLOCK, never an exception.
 */
export async function gateRows(rows: MatrixRow[], session: MarketSession | null, opts: GateRunOptions = {}): Promise<TickerCheck[]> {
  const usd = opts.usd ?? 25;
  const quote = opts.deps?.getQuote ?? getQuote;
  const now = opts.now ?? Date.now;
  const groups = [...groupRows(rows)].sort(([a, ra], [b, rb]) => rb.length - ra.length || a.localeCompare(b));
  const sizes = [usd, ...(opts.ladderSizes ?? []).filter((s) => s !== usd)];
  const total = groups.reduce((n, [, g]) => n + g.length * sizes.length, 0);
  let done = 0;

  const quoteRow = async (r: MatrixRow) => {
    const qopts: QuoteOptions = { multiplier: r.multiplier, reference: r.reference, wallet: opts.wallet };
    const out = await Promise.all(
      sizes.map(async (s) => {
        const q = await quote(venueOf(r), s, qopts);
        opts.onProgress?.(++done, total);
        return q;
      }),
    );
    return { row: r, quote: out[0] ?? null, ladder: out.slice(1) };
  };

  // Each ticker is gated as soon as its own quotes land, so quote age reflects that ticker, not the whole sweep.
  return Promise.all(
    groups.map(async ([, g]) => {
      const inputs = await Promise.all(g.map(quoteRow));
      return {
        ...evaluateTicker(inputs, { session: session?.session ?? null, now: now() }, opts.policy ?? DEFAULT_POLICY),
        rows: g,
        usd,
      };
    }),
  );
}

export async function checkTicker(ticker: string, opts: GateRunOptions = {}): Promise<TickerCheck & { marketSession: MarketSession | null }> {
  const matrix = await (opts.deps?.buildMatrix ?? buildMatrix)({ scope: "all", tickers: [ticker] });
  if (!matrix.rows.length) throw new Error(`No BSC tokenized stock for ticker "${ticker}".`);
  const [check] = await gateRows(matrix.rows, matrix.session, opts);
  return { ...check!, marketSession: matrix.session };
}

export interface Snapshot {
  builtAt: number;
  elapsedMs: number;
  usd: number;
  session: MarketSession | null;
  tickers: TickerCheck[];
  summary: { tickers: number; venues: number; go: number; caution: number; block: number; quoteErrors: number; withBestVenue: number };
}

export interface SnapshotOptions extends GateRunOptions {
  scope?: "multi" | "all";
  tickers?: string[];
}

export function summarizeSnapshot(tickers: TickerCheck[]): Snapshot["summary"] {
  const venues = tickers.flatMap((t) => t.venues);
  const count = (v: Verdict) => venues.filter((x) => x.verdict === v).length;
  return {
    tickers: tickers.length,
    venues: venues.length,
    go: count("GO"),
    caution: count("CAUTION"),
    block: count("BLOCK"),
    quoteErrors: venues.filter((v) => v.quote && !v.quote.ok).length,
    withBestVenue: tickers.filter((t) => t.bestVenue).length,
  };
}

export async function buildSnapshot(opts: SnapshotOptions = {}): Promise<Snapshot> {
  const started = Date.now();
  const usd = opts.usd ?? 25;
  const matrix = await (opts.deps?.buildMatrix ?? buildMatrix)({ scope: opts.scope ?? "multi", tickers: opts.tickers });
  const tickers = (await gateRows(matrix.rows, matrix.session, { ...opts, usd, ladderSizes: [] })).sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { builtAt: started, elapsedMs: Date.now() - started, usd, session: matrix.session, tickers, summary: summarizeSnapshot(tickers) };
}

const cache = new Map<string, { at: number; snap: Promise<Snapshot> }>();

/** In-memory cache (default 60s) so the CLI and the web desk share one sweep; concurrent callers share the in-flight build. */
export function getSnapshot(opts: SnapshotOptions & { maxAgeMs?: number } = {}): Promise<Snapshot> {
  const { maxAgeMs = 60_000, ...rest } = opts;
  const key = JSON.stringify({ scope: rest.scope ?? "multi", tickers: rest.tickers ?? null, usd: rest.usd ?? 25 });
  const hit = cache.get(key);
  const now = (rest.now ?? Date.now)();
  if (hit && now - hit.at < maxAgeMs) return hit.snap;
  const snap = buildSnapshot(rest);
  cache.set(key, { at: now, snap });
  snap.catch(() => cache.delete(key));
  return snap;
}

export function clearSnapshotCache(): void {
  cache.clear();
}
