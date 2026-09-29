import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateTicker,
  summarizeSnapshot,
  toPublicSession,
  toPublicSnapshot,
  type MatrixRow,
  type PublicSnapshot,
  type QuoteFail,
  type QuoteOk,
  type Snapshot,
  type TickerCheck,
} from "../src/index";

const NOW = 1_800_000_000_000;

const row = (symbol: string, platform: MatrixRow["platform"], perShare: number): MatrixRow => ({
  ticker: "TEST",
  platform,
  symbol,
  address: `0x${symbol.toLowerCase()}`,
  tokenPrice: perShare,
  multiplier: 1,
  perShare,
  reference: 100,
  referenceSource: "ondo",
  displayedGapPct: perShare / 100 - 1,
  assetStatus: null,
  holders: 42,
  flags: perShare < 97 ? ["LARGE_DISPLAYED_GAP"] : [],
});

const ok = (symbol: string, fill: number): QuoteOk => ({
  symbol,
  address: `0x${symbol.toLowerCase()}`,
  usd: 25,
  ts: NOW,
  source: "binance-aggregator",
  ok: true,
  tokensOut: 25 / fill,
  multiplier: 1,
  fillPerToken: fill,
  fillPerShare: fill,
  reference: 100,
  executableGapPct: fill / 100 - 1,
  executionMode: "SWAP",
  vendorName: "LiquidMesh",
  route: ["USDT", symbol],
  protocols: ["X"],
  vendorPriceImpact: 0.001,
  networkFeeUsd: 0.02,
  gasLimit: 450000,
  quoteId: "secret-quote-id",
  routeCount: 1,
  approveTarget: "0xrouter",
  tokenDecimals: 18,
});

const fail = (symbol: string): QuoteFail => ({
  symbol,
  address: `0x${symbol.toLowerCase()}`,
  usd: 25,
  ts: NOW,
  source: "binance-aggregator",
  ok: false,
  reason: "NO_LIQUIDITY",
  code: 40374,
  message: "Insufficient liquidity for a quote.",
});

function mkSnapshot(): Snapshot {
  const rows = [row("TESTon", "ondo", 100.1), row("TESTx", "xstocks", 90)];
  const verdict = evaluateTicker(
    [
      { row: rows[0]!, quote: ok("TESTon", 100.2) },
      { row: rows[1]!, quote: fail("TESTx") },
    ],
    { session: "regular", now: NOW },
  );
  const tickers: TickerCheck[] = [{ ...verdict, rows, usd: 25 }];
  return {
    builtAt: NOW,
    elapsedMs: 1000,
    usd: 25,
    session: {
      session: "regular",
      open: true,
      reasonCode: null,
      reasonMsg: null,
      nextOpen: new Date("2026-09-29T20:01:00Z"),
      nextClose: new Date("2026-09-29T19:59:00Z"),
      nextEvent: { type: "close", at: new Date("2026-09-29T19:59:00Z") },
      offhours: null,
      raw: {} as never,
    },
    tickers,
    summary: summarizeSnapshot(tickers),
  };
}

describe("toPublicSnapshot", () => {
  const pub = toPublicSnapshot(mkSnapshot());

  it("keeps verdicts, reasons and prices per venue", () => {
    const t = pub.tickers[0]!;
    expect(t.best).toBe("TESTon");
    expect(t.referenceSource).toBe("ondo");
    const on = t.venues.find((v) => v.symbol === "TESTon")!;
    expect(on.verdict).toBe("GO");
    expect(on.displayedPerShare).toBe(100.1);
    expect(on.fillPerShare).toBeCloseTo(100.2);
    expect(on.holders).toBe(42);
    expect(on.quote).toMatchObject({ ok: true, mode: "SWAP", vendor: "LiquidMesh", route: ["USDT", "TESTon"] });
    const x = t.venues.find((v) => v.symbol === "TESTx")!;
    expect(x.verdict).toBe("BLOCK");
    expect(x.flags).toEqual(["LARGE_DISPLAYED_GAP"]);
    expect(x.quote).toMatchObject({ ok: false, code: "40374", reason: "NO_LIQUIDITY" });
    expect(x.reasons.some((r) => r.severity === "block")).toBe(true);
  });

  it("drops quote ids, routers and the raw session body", () => {
    const json = JSON.stringify(pub);
    expect(json).not.toContain("secret-quote-id");
    expect(json).not.toContain("0xrouter");
    expect(json).not.toContain('"raw"');
  });

  it("serializes session dates as ISO strings, also from JSON input", () => {
    expect(pub.session).toEqual({
      session: "regular",
      open: true,
      nextOpen: "2026-09-29T20:01:00.000Z",
      nextClose: "2026-09-29T19:59:00.000Z",
      nextEvent: { type: "close", at: "2026-09-29T19:59:00.000Z" },
    });
    const viaJson = JSON.parse(JSON.stringify(mkSnapshot().session));
    expect(toPublicSession(viaJson)).toEqual(pub.session);
    expect(toPublicSession(null)).toBeNull();
  });
});

describe("committed web snapshot", () => {
  const file = resolve(import.meta.dirname, "../../../apps/web/data/snapshot.json");
  const text = readFileSync(file, "utf8");
  const snap = JSON.parse(text) as PublicSnapshot;

  it("is the slim public shape and stays small enough to ship", () => {
    expect(snap.version).toBe(1);
    expect(text.length).toBeLessThan(1_500_000);
    expect(text).not.toContain("quoteId");
    expect(text).not.toContain("approveTarget");
    expect(snap.summary.venues).toBe(snap.tickers.reduce((n, t) => n + t.venues.length, 0));
  });

  it("never recommends a BLOCK venue", () => {
    for (const t of snap.tickers) {
      if (!t.best) continue;
      expect(t.venues.find((v) => v.symbol === t.best)?.verdict).not.toBe("BLOCK");
    }
  });
});
