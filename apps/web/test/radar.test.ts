import { describe, expect, it } from "vitest";
import type { PublicSnapshot, PublicTicker, PublicVenue } from "@gapdesk/core";
import { countTraps, filterRows, geoRefused, pickExamples, sortRows, toRadarRow, toRadarRows } from "../lib/radar";
import { countdown, pct } from "../lib/format";

const venue = (symbol: string, o: Partial<PublicVenue> = {}): PublicVenue => ({
  symbol,
  platform: "ondo",
  address: "0x",
  verdict: "GO",
  reasons: [],
  displayedPerShare: 100,
  displayedGapPct: 0,
  fillPerShare: 100,
  executableGapPct: 0.001,
  impactPct: {},
  holders: null,
  flags: [],
  quote: null,
  ...o,
});

const ticker = (t: string, venues: PublicVenue[], best: string | null): PublicTicker => ({ ticker: t, reference: 100, referenceSource: "ondo", session: "regular", usd: 25, best, venues });

const blockReason = (message: string) => [{ code: "GAP_TOO_WIDE" as const, severity: "block" as const, message }];

const snap: PublicSnapshot = {
  version: 1,
  builtAt: 0,
  elapsedMs: 0,
  usd: 25,
  session: null,
  summary: { tickers: 4, venues: 6, go: 3, caution: 0, block: 3, quoteErrors: 1, withBestVenue: 3 },
  tickers: [
    ticker("MSTR", [venue("MSTRB", { platform: "bstocks", executableGapPct: 0.0027 }), venue("MSTRx", { platform: "xstocks", verdict: "BLOCK", displayedGapPct: -0.107, executableGapPct: null, fillPerShare: null, reasons: blockReason("no liquidity") })], "MSTRB"),
    ticker("AAOI", [venue("AAOIB", { platform: "bstocks", verdict: "BLOCK", displayedGapPct: -0.005, executableGapPct: 3.89, reasons: blockReason("Fill is +389% off the stock") })], null),
    ticker("NVDA", [venue("NVDAon", { executableGapPct: -0.0006, displayedGapPct: 0.001 }), venue("NVDAB", { platform: "bstocks", displayedGapPct: -0.002 })], "NVDAon"),
    ticker("ZZZ", [venue("ZZZon", { displayedGapPct: null, executableGapPct: null })], "ZZZon"),
  ],
};

describe("radar rows", () => {
  const rows = toRadarRows(snap);

  it("summarizes each ticker: best verdict, best venue and loudest displayed gap", () => {
    const mstr = rows.find((r) => r.ticker === "MSTR")!;
    expect(mstr.verdict).toBe("GO");
    expect(mstr.best).toMatchObject({ symbol: "MSTRB", executableGapPct: 0.0027 });
    expect(mstr.loudest).toMatchObject({ symbol: "MSTRx", displayedGapPct: -0.107, verdict: "BLOCK" });
    const aaoi = toRadarRow(snap.tickers[1]!);
    expect(aaoi.verdict).toBe("BLOCK");
    expect(aaoi.best).toBeNull();
    expect(aaoi.headline).toBe("Fill is +389% off the stock");
  });

  it("sorts by absolute displayed gap with missing values last in both directions", () => {
    expect(sortRows(rows, "displayed", "desc").map((r) => r.ticker)).toEqual(["MSTR", "AAOI", "NVDA", "ZZZ"]);
    expect(sortRows(rows, "displayed", "asc").map((r) => r.ticker)).toEqual(["NVDA", "AAOI", "MSTR", "ZZZ"]);
    expect(sortRows(rows, "executable", "asc").map((r) => r.ticker).at(-1)).toBe("ZZZ");
    expect(sortRows(rows, "verdict", "desc")[0]!.ticker).toBe("AAOI");
    expect(sortRows(rows, "ticker", "desc").map((r) => r.ticker)).toEqual(["ZZZ", "NVDA", "MSTR", "AAOI"]);
  });

  it("filters multi-venue, hides BLOCK and searches tickers and venue symbols", () => {
    const f = { multiOnly: false, hideBlock: false, query: "" };
    expect(filterRows(rows, f)).toHaveLength(4);
    expect(filterRows(rows, { ...f, multiOnly: true }).map((r) => r.ticker)).toEqual(["MSTR", "NVDA"]);
    expect(filterRows(rows, { ...f, hideBlock: true }).map((r) => r.ticker)).not.toContain("AAOI");
    expect(filterRows(rows, { ...f, query: "mstrx" }).map((r) => r.ticker)).toEqual(["MSTR"]);
  });

  it("picks the displayed-discount trap and the thin-pool trap", () => {
    const { mirage, thinPool } = pickExamples(snap);
    expect(mirage).toMatchObject({ symbol: "MSTRx", best: { symbol: "MSTRB" } });
    expect(thinPool).toMatchObject({ symbol: "AAOIB", executableGapPct: 3.89 });
    expect(countTraps(snap)).toBe(1);
  });

  it("tells a region refusal (40304 on every venue) apart from real venue failures", () => {
    const refused = { ok: false as const, ts: 0, usd: 25, mode: null, vendor: null, route: [], tokensOut: null, networkFeeUsd: null, reason: "UNKNOWN_ERROR", code: "40304", message: "Service not available due to compliance restriction" };
    const liquidity = { ...refused, reason: "NO_LIQUIDITY", code: "40374", message: "no liquidity" };
    expect(geoRefused(ticker("MSTR", [venue("MSTRB", { quote: refused }), venue("MSTRx", { quote: refused })], null))).toBe(true);
    expect(geoRefused(ticker("MSTR", [venue("MSTRB", { quote: refused }), venue("MSTRx", { quote: liquidity })], null))).toBe(false);
    expect(geoRefused(snap.tickers[0]!)).toBe(false);
  });
});

describe("format", () => {
  it("formats percents and countdowns", () => {
    expect(pct(0.0027)).toBe("+0.27%");
    expect(pct(-0.107)).toBe("-10.70%");
    expect(pct(null)).toBe("n/a");
    expect(pct(40)).toBe("+4,000%");
    expect(countdown(3 * 3600_000 + 56 * 60_000)).toBe("3h 56m");
    expect(countdown(65_000)).toBe("1m 05s");
    expect(countdown(-1)).toBe("now");
  });
});
