import type { Platform } from "./config";
import { ApiError } from "./http";
import { byTicker, loadRegistry, multiVenue, type Venue } from "./registry";
import { getDynamic, gapPct, referenceFor, type Reference, type VenuePrice } from "./prices";
import { getMarketSession, type AssetStatus, type MarketSession } from "./session";

export type MatrixFlag =
  | "NO_PRICE"
  | "NO_REFERENCE"
  | "LARGE_DISPLAYED_GAP"
  | "STATUS_MISSING"
  | "API_ERROR"
  | "MULTIPLIER_MISMATCH";

export interface MatrixRow {
  ticker: string;
  platform: Platform;
  symbol: string;
  address: string;
  tokenPrice: number | null;
  multiplier: number | null;
  perShare: number | null;
  reference: number | null;
  referenceSource: Reference["source"];
  displayedGapPct: number | null;
  assetStatus: AssetStatus | null;
  holders: number | null;
  flags: MatrixFlag[];
  error?: { code: string | number | null; message: string };
}

export interface MatrixThresholds {
  largeGapPct: number;
  multiplierMismatchPct: number;
}

export const DEFAULT_THRESHOLDS: MatrixThresholds = {
  largeGapPct: 0.03,
  multiplierMismatchPct: 0.005,
};

export interface MatrixResult {
  builtAt: number;
  elapsedMs: number;
  session: MarketSession | null;
  rows: MatrixRow[];
  summary: { tickers: number; venues: number; flagged: number; errors: number };
}

export interface BuildMatrixOptions {
  scope?: "multi" | "all";
  tickers?: string[];
  thresholds?: MatrixThresholds;
  withSession?: boolean;
  deps?: {
    loadRegistry?: () => Promise<Venue[]>;
    getDynamic?: (v: Venue) => Promise<VenuePrice>;
    getMarketSession?: () => Promise<MarketSession>;
  };
}

type DynamicResult = VenuePrice | Error;

export function assembleRows(
  groups: Map<string, Venue[]>,
  results: Map<string, DynamicResult>,
  thresholds: MatrixThresholds = DEFAULT_THRESHOLDS,
): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const [ticker, venues] of groups) {
    const ok = venues
      .map((v) => results.get(v.address))
      .filter((r): r is VenuePrice => r !== undefined && !(r instanceof Error));
    const ref = referenceFor(ok);

    for (const v of venues) {
      const r = results.get(v.address);
      if (!r || r instanceof Error) {
        const err = r instanceof ApiError ? { code: r.code ?? r.httpStatus, message: r.message } : { code: null, message: r?.message ?? "not fetched" };
        rows.push({
          ticker,
          platform: v.platform,
          symbol: v.symbol,
          address: v.address,
          tokenPrice: null,
          multiplier: null,
          perShare: null,
          reference: ref.price,
          referenceSource: ref.source,
          displayedGapPct: null,
          assetStatus: null,
          holders: null,
          flags: ["API_ERROR"],
          error: err,
        });
        continue;
      }

      const gap = gapPct(r.perShare, ref.price);
      const flags: MatrixFlag[] = [];
      if (r.perShare === null) flags.push("NO_PRICE");
      if (ref.price === null) flags.push("NO_REFERENCE");
      if (gap !== null && Math.abs(gap) >= thresholds.largeGapPct) flags.push("LARGE_DISPLAYED_GAP");
      if (r.status.sessionMissing) flags.push("STATUS_MISSING");
      if (r.multiplierSource === "dynamic" && Math.abs(r.multiplier - v.multiplier) / r.multiplier > thresholds.multiplierMismatchPct) {
        flags.push("MULTIPLIER_MISMATCH");
      }
      rows.push({
        ticker,
        platform: v.platform,
        symbol: v.symbol,
        address: v.address,
        tokenPrice: r.tokenPrice,
        multiplier: r.multiplier,
        perShare: r.perShare,
        reference: ref.price,
        referenceSource: ref.source,
        displayedGapPct: gap,
        assetStatus: r.status,
        holders: r.holders,
        flags,
      });
    }
  }
  return rows;
}

export function summarize(rows: MatrixRow[]): MatrixResult["summary"] {
  return {
    tickers: new Set(rows.map((r) => r.ticker)).size,
    venues: rows.length,
    flagged: rows.filter((r) => r.flags.some((f) => f !== "STATUS_MISSING")).length,
    errors: rows.filter((r) => r.flags.includes("API_ERROR")).length,
  };
}

export async function buildMatrix(opts: BuildMatrixOptions = {}): Promise<MatrixResult> {
  const started = Date.now();
  const load = opts.deps?.loadRegistry ?? loadRegistry;
  const fetchDynamic = opts.deps?.getDynamic ?? getDynamic;
  const fetchSession = opts.deps?.getMarketSession ?? (() => getMarketSession());

  const sessionPromise = opts.withSession === false ? Promise.resolve(null) : fetchSession().catch(() => null);
  const venues = await load();
  let groups = opts.scope === "all" ? byTicker(venues) : multiVenue(venues);
  if (opts.tickers?.length) {
    const wanted = new Set(opts.tickers.map((t) => t.trim().toUpperCase()));
    groups = new Map([...byTicker(venues)].filter(([t]) => wanted.has(t)));
  }

  const targets = [...groups.values()].flat();
  const settled = await Promise.allSettled(targets.map((v) => fetchDynamic(v)));
  const results = new Map<string, DynamicResult>();
  settled.forEach((s, i) => {
    const v = targets[i]!;
    results.set(v.address, s.status === "fulfilled" ? s.value : s.reason instanceof Error ? s.reason : new Error(String(s.reason)));
  });

  const rows = assembleRows(groups, results, opts.thresholds);
  return {
    builtAt: started,
    elapsedMs: Date.now() - started,
    session: await sessionPromise,
    rows,
    summary: summarize(rows),
  };
}

/** Largest absolute displayed gap first; rows without a gap sink to the bottom. */
export function sortByGap(rows: MatrixRow[]): MatrixRow[] {
  const key = (r: MatrixRow) => (r.displayedGapPct === null ? -1 : Math.abs(r.displayedGapPct));
  return [...rows].sort((a, b) => key(b) - key(a) || a.ticker.localeCompare(b.ticker));
}
