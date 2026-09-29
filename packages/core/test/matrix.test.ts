import { describe, expect, it } from "vitest";
import {
  ApiError,
  DynamicSchema,
  assembleRows,
  buildMatrix,
  multiVenue,
  parseDynamic,
  sortByGap,
  type MatrixRow,
  type VenuePrice,
} from "../src/index";
import { fixturePrice, fixtureVenues } from "./helpers";

const venues = fixtureVenues();
const groups = multiVenue(venues);
const allFixturePrices = () => new Map<string, VenuePrice | Error>(venues.map((v) => [v.address, fixturePrice(v)]));
const row = (rows: MatrixRow[], symbol: string) => rows.find((r) => r.symbol === symbol)!;

describe("assembleRows", () => {
  const rows = assembleRows(groups, allFixturePrices());

  it("produces one row per venue with an Ondo reference", () => {
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.referenceSource === "ondo")).toBe(true);
  });

  it("flags MSTRx's stale price as a large displayed gap", () => {
    const mstrx = row(rows, "MSTRx");
    expect(mstrx.displayedGapPct!).toBeLessThan(-0.03);
    expect(mstrx.flags).toContain("LARGE_DISPLAYED_GAP");
  });

  it("does not flag Ondo NVDA, which tracks the reference", () => {
    const nvdaon = row(rows, "NVDAon");
    expect(Math.abs(nvdaon.displayedGapPct!)).toBeLessThan(0.01);
    expect(nvdaon.flags).toEqual([]);
  });

  it("marks xStocks and bStocks STATUS_MISSING but not Ondo", () => {
    expect(row(rows, "NVDAB").flags).toContain("STATUS_MISSING");
    expect(row(rows, "NVDAx").flags).toContain("STATUS_MISSING");
    expect(row(rows, "NVDAon").flags).not.toContain("STATUS_MISSING");
  });

  it("flags a registry vs dynamic multiplier mismatch above 0.5%", () => {
    expect(row(rows, "SPYx").flags).toContain("MULTIPLIER_MISMATCH");
    expect(row(rows, "NVDAx").flags).not.toContain("MULTIPLIER_MISMATCH");
  });

  it("flags NO_PRICE and NO_REFERENCE", () => {
    const results = allFixturePrices();
    const nvda = groups.get("NVDA")!;
    const empty = (i: number) => parseDynamic(nvda[i]!, DynamicSchema.parse({ tokenInfo: { price: null }, stockInfo: { price: null } }));
    results.set(nvda[0]!.address, empty(0));
    results.set(nvda[2]!.address, empty(2));
    const out = assembleRows(new Map([["NVDA", nvda]]), results);
    expect(row(out, "NVDAon").flags).toEqual(expect.arrayContaining(["NO_PRICE", "NO_REFERENCE"]));
    expect(row(out, "NVDAB").flags).toContain("NO_REFERENCE");
    expect(row(out, "NVDAB").displayedGapPct).toBeNull();
  });
});

describe("buildMatrix", () => {
  const deps = (failing: Set<string>) => ({
    loadRegistry: async () => venues,
    getMarketSession: async () => {
      throw new Error("session down");
    },
    getDynamic: async (v: (typeof venues)[number]) => {
      if (failing.has(v.symbol)) {
        throw new ApiError({ endpoint: "rwa/dynamic", httpStatus: 500, code: "000002", msg: "internal error" });
      }
      return fixturePrice(v);
    },
  });

  it("isolates a failing venue without failing the matrix", async () => {
    const result = await buildMatrix({ deps: deps(new Set(["NVDAx"])) });
    const nvdax = row(result.rows, "NVDAx");
    expect(nvdax.flags).toEqual(["API_ERROR"]);
    expect(nvdax.error).toEqual({ code: "000002", message: "internal error" });
    expect(row(result.rows, "NVDAon").perShare).not.toBeNull();
    expect(result.summary).toMatchObject({ tickers: 4, venues: 12, errors: 1 });
  });

  it("returns a null session instead of throwing when the status endpoint fails", async () => {
    const result = await buildMatrix({ deps: deps(new Set()) });
    expect(result.session).toBeNull();
    expect(result.rows).toHaveLength(12);
  });

  it("filters to requested tickers, including single-venue ones", async () => {
    const result = await buildMatrix({ tickers: [" mstr "], deps: deps(new Set()) });
    expect(new Set(result.rows.map((r) => r.ticker))).toEqual(new Set(["MSTR"]));
  });
});

describe("sortByGap", () => {
  it("orders by absolute gap and sinks rows without a gap", () => {
    const base = { flags: [], ticker: "T" } as unknown as MatrixRow;
    const sorted = sortByGap([
      { ...base, symbol: "a", displayedGapPct: 0.01 },
      { ...base, symbol: "b", displayedGapPct: null },
      { ...base, symbol: "c", displayedGapPct: -0.2 },
    ]);
    expect(sorted.map((r) => r.symbol)).toEqual(["c", "a", "b"]);
  });
});
