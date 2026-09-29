import type { Platform } from "./config";
import type { GateReason, Verdict } from "./gate";
import type { MatrixFlag, MatrixRow } from "./matrix";
import type { SessionName } from "./session";
import type { Snapshot, TickerCheck } from "./snapshot";

/** What the web desk ships to browsers: verdicts, reasons and prices, without raw routes, quote ids or API bodies. */
export interface PublicQuote {
  ok: boolean;
  ts: number;
  usd: number;
  mode: string | null;
  vendor: string | null;
  route: string[];
  tokensOut: number | null;
  networkFeeUsd: number | null;
  /** Failed quotes only. */
  reason: string | null;
  code: string | null;
  message: string | null;
}

export interface PublicVenue {
  symbol: string;
  platform: Platform;
  address: string;
  verdict: Verdict;
  reasons: GateReason[];
  displayedPerShare: number | null;
  displayedGapPct: number | null;
  fillPerShare: number | null;
  executableGapPct: number | null;
  impactPct: Record<string, number | null>;
  holders: number | null;
  flags: MatrixFlag[];
  quote: PublicQuote | null;
}

export interface PublicTicker {
  ticker: string;
  reference: number | null;
  referenceSource: string;
  session: SessionName | null;
  usd: number;
  best: string | null;
  venues: PublicVenue[];
}

export interface PublicSession {
  session: SessionName;
  open: boolean;
  nextOpen: string | null;
  nextClose: string | null;
  nextEvent: { type: "open" | "close"; at: string } | null;
}

export interface PublicSnapshot {
  version: 1;
  builtAt: number;
  elapsedMs: number;
  usd: number;
  session: PublicSession | null;
  summary: Snapshot["summary"];
  tickers: PublicTicker[];
}

type DateLike = Date | string | null | undefined;

const iso = (d: DateLike): string | null => {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/** Accepts a live `MarketSession` or one that went through JSON (dates as strings). */
export function toPublicSession(
  s: { session: SessionName; open: boolean; nextOpen?: DateLike; nextClose?: DateLike; nextEvent?: { type: "open" | "close"; at: DateLike } | null } | null | undefined,
): PublicSession | null {
  if (!s) return null;
  const at = iso(s.nextEvent?.at);
  return {
    session: s.session,
    open: s.open,
    nextOpen: iso(s.nextOpen),
    nextClose: iso(s.nextClose),
    nextEvent: s.nextEvent && at ? { type: s.nextEvent.type, at } : null,
  };
}

export function toPublicTicker(t: TickerCheck): PublicTicker {
  const rowBySymbol = new Map<string, MatrixRow>(t.rows.map((r) => [r.symbol, r]));
  return {
    ticker: t.ticker,
    reference: t.reference,
    referenceSource: t.rows[0]?.referenceSource ?? "none",
    session: t.session,
    usd: t.usd,
    best: t.bestVenue?.symbol ?? null,
    venues: t.venues.map((v): PublicVenue => {
      const row = rowBySymbol.get(v.symbol);
      const q = v.quote;
      return {
        symbol: v.symbol,
        platform: v.platform,
        address: row?.address ?? q?.address ?? "",
        verdict: v.verdict,
        reasons: v.reasons.map(({ code, severity, message }) => ({ code, severity, message })),
        displayedPerShare: row?.perShare ?? null,
        displayedGapPct: v.displayedGapPct,
        fillPerShare: v.fillPerShare,
        executableGapPct: v.executableGapPct,
        impactPct: Object.fromEntries(Object.entries(v.impactPct ?? {}).map(([k, x]) => [k, x ?? null])),
        holders: row?.holders ?? null,
        flags: row?.flags ?? [],
        quote: q
          ? q.ok
            ? { ok: true, ts: q.ts, usd: q.usd, mode: q.executionMode, vendor: q.vendorName, route: q.route, tokensOut: q.tokensOut, networkFeeUsd: q.networkFeeUsd, reason: null, code: null, message: null }
            : { ok: false, ts: q.ts, usd: q.usd, mode: null, vendor: null, route: [], tokensOut: null, networkFeeUsd: null, reason: q.reason, code: q.code === null ? null : String(q.code), message: q.message }
          : null,
      };
    }),
  };
}

export function toPublicSnapshot(s: Snapshot): PublicSnapshot {
  return {
    version: 1,
    builtAt: s.builtAt,
    elapsedMs: s.elapsedMs,
    usd: s.usd,
    session: toPublicSession(s.session),
    summary: s.summary,
    tickers: s.tickers.map(toPublicTicker),
  };
}
