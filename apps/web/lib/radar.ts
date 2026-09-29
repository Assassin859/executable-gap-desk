import type { Platform, PublicSnapshot, PublicTicker, Verdict } from "@gapdesk/core";
import { VERDICT_RANK } from "./format";

export interface RadarVenue {
  symbol: string;
  platform: Platform;
  verdict: Verdict;
}

export interface RadarRow {
  ticker: string;
  reference: number | null;
  venues: RadarVenue[];
  /** Best verdict across the ticker's venues: GO if any venue is GO. */
  verdict: Verdict;
  best: { symbol: string; platform: Platform; executableGapPct: number | null; fillPerShare: number | null } | null;
  /** The venue whose displayed price is furthest from the stock: the gap a naive screen would chase. */
  loudest: { symbol: string; displayedGapPct: number; verdict: Verdict } | null;
  headline: string | null;
}

export type SortKey = "ticker" | "venues" | "displayed" | "executable" | "verdict";

export interface RadarFilter {
  multiOnly: boolean;
  hideBlock: boolean;
  query: string;
}

export function toRadarRow(t: PublicTicker): RadarRow {
  const venues = t.venues.map((v) => ({ symbol: v.symbol, platform: v.platform, verdict: v.verdict }));
  const verdict = venues.reduce<Verdict>((acc, v) => (VERDICT_RANK[v.verdict] < VERDICT_RANK[acc] ? v.verdict : acc), "BLOCK");
  const bestV = t.best ? t.venues.find((v) => v.symbol === t.best) : undefined;
  const loudestV = [...t.venues]
    .filter((v) => v.displayedGapPct !== null)
    .sort((a, b) => Math.abs(b.displayedGapPct!) - Math.abs(a.displayedGapPct!))[0];
  const firstBlock = t.venues.find((v) => v.verdict === "BLOCK")?.reasons.find((r) => r.severity === "block");
  return {
    ticker: t.ticker,
    reference: t.reference,
    venues,
    verdict,
    best: bestV ? { symbol: bestV.symbol, platform: bestV.platform, executableGapPct: bestV.executableGapPct, fillPerShare: bestV.fillPerShare } : null,
    loudest: loudestV ? { symbol: loudestV.symbol, displayedGapPct: loudestV.displayedGapPct!, verdict: loudestV.verdict } : null,
    headline: bestV ? null : (firstBlock?.message ?? null),
  };
}

export const toRadarRows = (s: PublicSnapshot): RadarRow[] => s.tickers.map(toRadarRow);

const numericKey: Partial<Record<SortKey, (r: RadarRow) => number | null>> = {
  venues: (r) => r.venues.length,
  displayed: (r) => (r.loudest ? Math.abs(r.loudest.displayedGapPct) : null),
  executable: (r) => (r.best?.executableGapPct == null ? null : Math.abs(r.best.executableGapPct)),
  verdict: (r) => VERDICT_RANK[r.verdict],
};

/** Missing values (no price, no safe venue) always sort last, whichever direction is chosen. */
export function sortRows(rows: RadarRow[], key: SortKey, dir: "asc" | "desc"): RadarRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const val = numericKey[key];
  return [...rows].sort((a, b) => {
    if (!val) return sign * a.ticker.localeCompare(b.ticker);
    const x = val(a);
    const y = val(b);
    if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0) || a.ticker.localeCompare(b.ticker);
    return sign * (x - y) || a.ticker.localeCompare(b.ticker);
  });
}

export function filterRows(rows: RadarRow[], f: RadarFilter): RadarRow[] {
  const q = f.query.trim().toUpperCase();
  return rows.filter(
    (r) =>
      (!f.multiOnly || r.venues.length >= 2) &&
      (!f.hideBlock || r.verdict !== "BLOCK") &&
      (!q || r.ticker.includes(q) || r.venues.some((v) => v.symbol.toUpperCase().includes(q))),
  );
}

export interface Example {
  ticker: string;
  symbol: string;
  displayedGapPct: number | null;
  executableGapPct: number | null;
  best: { symbol: string; executableGapPct: number | null } | null;
  reason: string;
}

/**
 * Two "start here" cards: the biggest displayed discount that cannot be bought (a blocked venue 3%+ off
 * while another venue of the same stock is GO), and the worst thin-pool fill behind a normal-looking price.
 */
export function pickExamples(s: PublicSnapshot): { mirage: Example | null; thinPool: Example | null } {
  let mirage: Example | null = null;
  let thinPool: Example | null = null;
  for (const t of s.tickers) {
    const best = t.best ? t.venues.find((v) => v.symbol === t.best) : undefined;
    for (const v of t.venues) {
      if (v.verdict !== "BLOCK") continue;
      const reason = v.reasons.find((r) => r.severity === "block")?.message ?? "";
      const ex: Example = {
        ticker: t.ticker,
        symbol: v.symbol,
        displayedGapPct: v.displayedGapPct,
        executableGapPct: v.executableGapPct,
        best: best ? { symbol: best.symbol, executableGapPct: best.executableGapPct } : null,
        reason,
      };
      const d = Math.abs(v.displayedGapPct ?? 0);
      if (best?.verdict === "GO" && d >= 0.03 && d < 0.5 && (!mirage || d > Math.abs(mirage.displayedGapPct ?? 0))) mirage = ex;
      const e = v.executableGapPct ?? 0;
      if (d < 0.01 && e > 0.5 && e < 20 && (!thinPool || e > (thinPool.executableGapPct ?? 0))) thinPool = ex;
    }
  }
  return { mirage, thinPool };
}

/** Blocked venues whose displayed price is 3%+ off the stock: the traps the desk exists to catch. */
export function countTraps(s: PublicSnapshot): number {
  return s.tickers.flatMap((t) => t.venues).filter((v) => v.verdict === "BLOCK" && v.displayedGapPct !== null && Math.abs(v.displayedGapPct) >= 0.03).length;
}

/** The quote API answers 40304 to some cloud regions (US); that says nothing about the venue. */
export function geoRefused(t: PublicTicker): boolean {
  return t.venues.length > 0 && t.venues.every((v) => v.quote?.ok === false && v.quote.code === "40304");
}
