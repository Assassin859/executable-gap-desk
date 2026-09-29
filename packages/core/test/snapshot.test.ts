import { afterEach, describe, expect, it } from "vitest";
import {
  MissingCredentialsError,
  assembleRows,
  buildSnapshot,
  byTicker,
  checkTicker,
  clearSnapshotCache,
  getSnapshot,
  normalizeMarketStatus,
  MarketStatusSchema,
  type ExecQuote,
  type MatrixResult,
  type Venue,
  type VenuePrice,
} from "../src/index";
import { QUOTE_TIME, fixture, fixturePrice, fixtureQuote, fixtureVenues } from "./helpers";

const venues = fixtureVenues();
const solo: Venue = { ticker: "SOLO", platform: "bstocks", symbol: "SOLOB", address: "0xsolo", multiplier: 1 };
const session = normalizeMarketStatus(MarketStatusSchema.parse(fixture("market-status.json")), QUOTE_TIME);

function fixtureMatrix(extra: Venue[] = []): MatrixResult {
  const all = [...venues, ...extra];
  const prices = new Map<string, VenuePrice | Error>(all.map((v) => [v.address, v === solo ? new Error("no dynamic") : fixturePrice(v)]));
  const rows = assembleRows(byTicker(all), prices);
  return { builtAt: QUOTE_TIME, elapsedMs: 1, session, rows, summary: { tickers: 0, venues: rows.length, flagged: 0, errors: 0 } };
}

function deps(extra: Venue[] = [], fail?: (v: Venue) => unknown) {
  const calls: string[] = [];
  let builds = 0;
  return {
    calls,
    builds: () => builds,
    deps: {
      buildMatrix: async () => {
        builds++;
        return fixtureMatrix(extra);
      },
      getQuote: async (v: Venue, usd: number, o: { reference?: number | null }): Promise<ExecQuote> => {
        calls.push(`${v.symbol}@${usd}`);
        const f = fail?.(v);
        if (f) throw f;
        if (v === solo || v.symbol === "SOLOB") return fixtureQuote("MSTRx", 25, null);
        return fixtureQuote(v.symbol, usd, o.reference ?? null);
      },
    },
  };
}

const now = () => QUOTE_TIME + 5_000;

afterEach(() => {
  clearSnapshotCache();
});

describe("buildSnapshot", () => {
  it("quotes multi-venue tickers before single-venue ones and summarizes verdicts", async () => {
    const d = deps([solo]);
    const snap = await buildSnapshot({ scope: "all", deps: d.deps, now });
    expect(d.calls.at(-1)).toBe("SOLOB@25");
    expect(d.calls).toHaveLength(13);
    expect(snap.tickers.map((t) => t.ticker)).toEqual(["AAPL", "MSTR", "NVDA", "SOLO", "SPY"]);
    const s = snap.summary;
    expect(s.venues).toBe(13);
    expect(s.go + s.caution + s.block).toBe(13);
    expect(s.quoteErrors).toBeGreaterThanOrEqual(4);
    expect(snap.tickers.find((t) => t.ticker === "MSTR")!.venues.find((v) => v.symbol === "MSTRx")!.verdict).toBe("BLOCK");
  });

  it("turns a throwing quote into a BLOCKed venue instead of failing the sweep", async () => {
    const d = deps([], (v) => (v.symbol === "NVDAB" ? new TypeError("fetch failed") : undefined));
    const snap = await buildSnapshot({ deps: d.deps, now });
    const nvdab = snap.tickers.find((t) => t.ticker === "NVDA")!.venues.find((v) => v.symbol === "NVDAB")!;
    expect(nvdab.verdict).toBe("BLOCK");
    expect(nvdab.quote).toMatchObject({ ok: false, reason: "UNKNOWN_ERROR", message: "fetch failed" });
    expect(snap.tickers).toHaveLength(4);
  });

  it("still fails loudly when credentials are missing", async () => {
    const d = deps([], () => new MissingCredentialsError());
    await expect(buildSnapshot({ deps: d.deps, now })).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it("reports progress for every quote", async () => {
    const seen: Array<[number, number]> = [];
    await buildSnapshot({ deps: deps().deps, now, onProgress: (a, b) => seen.push([a, b]) });
    expect(seen).toHaveLength(12);
    expect(seen.at(-1)).toEqual([12, 12]);
  });
});

describe("getSnapshot cache", () => {
  it("reuses a fresh snapshot and rebuilds after maxAge", async () => {
    const d = deps();
    let t = QUOTE_TIME;
    const clock = () => t;
    const a = await getSnapshot({ deps: d.deps, now: clock });
    t += 30_000;
    const b = await getSnapshot({ deps: d.deps, now: clock });
    expect(b).toBe(a);
    expect(d.builds()).toBe(1);
    t += 31_000;
    await getSnapshot({ deps: d.deps, now: clock });
    expect(d.builds()).toBe(2);
  });

  it("shares one in-flight build between concurrent callers", async () => {
    const d = deps();
    const [a, b] = await Promise.all([getSnapshot({ deps: d.deps, now }), getSnapshot({ deps: d.deps, now })]);
    expect(a).toBe(b);
    expect(d.builds()).toBe(1);
  });

  it("keys the cache by scope, tickers and size", async () => {
    const d = deps();
    await getSnapshot({ deps: d.deps, now });
    await getSnapshot({ deps: d.deps, now, usd: 20 });
    await getSnapshot({ deps: d.deps, now, tickers: ["NVDA"] });
    expect(d.builds()).toBe(3);
  });
});

describe("checkTicker", () => {
  it("quotes the ladder sizes and fills the impact column", async () => {
    const d = deps();
    const card = await checkTicker("NVDA", {
      deps: { ...d.deps, buildMatrix: async () => ({ ...fixtureMatrix(), rows: fixtureMatrix().rows.filter((r) => r.ticker === "NVDA") }) },
      ladderSizes: [100, 500],
      now,
    });
    const nvdab = card.venues.find((v) => v.symbol === "NVDAB")!;
    expect(Object.keys(nvdab.impactPct).map(Number)).toEqual([25, 100, 500]);
    expect(card.bestVenue).not.toBeNull();
  });

  it("errors on an unknown ticker", async () => {
    const d = deps();
    await expect(
      checkTicker("NOPE", { deps: { ...d.deps, buildMatrix: async () => ({ ...fixtureMatrix(), rows: [] }) }, now }),
    ).rejects.toThrow('No BSC tokenized stock for ticker "NOPE".');
  });
});
