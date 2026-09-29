import { describe, expect, it } from "vitest";
import defaultPolicyJson from "../policy/default.json" with { type: "json" };
import {
  DEFAULT_POLICY,
  assembleRows,
  byTicker,
  evaluateTicker,
  evaluateVenue,
  parsePolicy,
  pickBest,
  venueDisagreement,
  type ExecQuote,
  type GateContext,
  type MatrixRow,
  type QuoteFail,
  type QuoteOk,
  type VenueInput,
  type VenuePrice,
} from "../src/index";
import { QUOTE_TIME, fixturePrice, fixtureQuote, fixtureVenues } from "./helpers";

const NOW = 1_800_000_000_000;

const mkRow = (o: Partial<MatrixRow> = {}): MatrixRow => ({
  ticker: "TEST",
  platform: "bstocks",
  symbol: "TESTB",
  address: "0xtest",
  tokenPrice: 100,
  multiplier: 1,
  perShare: 100,
  reference: 100,
  referenceSource: "ondo",
  displayedGapPct: 0,
  assetStatus: { open: true, session: "regular", reasonCode: "TRADING", reasonMsg: null, nextOpen: null, nextClose: null, sessionMissing: false },
  holders: null,
  flags: [],
  ...o,
});

const mkQuote = (fillPerShare: number, o: Partial<QuoteOk> = {}): QuoteOk => ({
  symbol: "TESTB",
  address: "0xtest",
  usd: 25,
  ts: NOW,
  source: "binance-aggregator",
  ok: true,
  tokensOut: 25 / fillPerShare,
  multiplier: 1,
  fillPerToken: fillPerShare,
  fillPerShare,
  reference: 100,
  executableGapPct: (fillPerShare - 100) / 100,
  executionMode: "SWAP",
  vendorName: "LiquidMesh",
  route: ["USDT", "TESTB"],
  protocols: ["X"],
  vendorPriceImpact: 0,
  networkFeeUsd: 0.02,
  gasLimit: 450000,
  quoteId: null,
  routeCount: 1,
  ...o,
});

const failQuote: QuoteFail = {
  symbol: "TESTB",
  address: "0xtest",
  usd: 25,
  ts: NOW,
  source: "binance-aggregator",
  ok: false,
  reason: "NO_LIQUIDITY",
  code: 40374,
  message: "Insufficient liquidity",
};

const regular: GateContext = { session: "regular", now: NOW };

type Case = {
  name: string;
  input: VenueInput;
  ctx?: Partial<GateContext>;
  verdict: "GO" | "CAUTION" | "BLOCK";
  codes: string[];
};

const cases: Case[] = [
  { name: "fill within ±0.75% is GO", input: { row: mkRow(), quote: mkQuote(100.5) }, verdict: "GO", codes: ["GAP_OK"] },
  { name: "fill +1.0% is CAUTION", input: { row: mkRow(), quote: mkQuote(101) }, verdict: "CAUTION", codes: ["GAP_WIDE"] },
  { name: "fill -1.1% is CAUTION", input: { row: mkRow(), quote: mkQuote(98.9) }, verdict: "CAUTION", codes: ["GAP_WIDE"] },
  { name: "fill +1.8% is BLOCK", input: { row: mkRow(), quote: mkQuote(101.8) }, verdict: "BLOCK", codes: ["GAP_TOO_WIDE"] },
  { name: "quote error is BLOCK", input: { row: mkRow(), quote: failQuote }, verdict: "BLOCK", codes: ["QUOTE_ERROR"] },
  { name: "missing quote is BLOCK", input: { row: mkRow(), quote: null }, verdict: "BLOCK", codes: ["NO_QUOTE"] },
  { name: "quote older than 60s is BLOCK", input: { row: mkRow(), quote: mkQuote(100.2, { ts: NOW - 61_000 }) }, verdict: "BLOCK", codes: ["QUOTE_STALE", "GAP_OK"] },
  { name: "size over the $25 cap is BLOCK", input: { row: mkRow(), quote: mkQuote(100.2, { usd: 26 }) }, verdict: "BLOCK", codes: ["SIZE_OVER_CAP", "GAP_OK"] },
  { name: "paused session is BLOCK", input: { row: mkRow(), quote: mkQuote(100.2) }, ctx: { session: "pause" }, verdict: "BLOCK", codes: ["MARKET_PAUSED", "GAP_OK"] },
  {
    name: "asset paused is BLOCK",
    input: { row: mkRow({ assetStatus: { ...mkRow().assetStatus!, reasonCode: "ASSET_PAUSED" } }), quote: mkQuote(100.2) },
    verdict: "BLOCK",
    codes: ["ASSET_NOT_OPEN", "GAP_OK"],
  },
  {
    name: "asset closed is BLOCK",
    input: { row: mkRow({ assetStatus: { ...mkRow().assetStatus!, open: false } }), quote: mkQuote(100.2) },
    verdict: "BLOCK",
    codes: ["ASSET_NOT_OPEN", "GAP_OK"],
  },
  {
    name: "displayed +4% vs executable +0.5% is BLOCK",
    input: { row: mkRow({ perShare: 104, displayedGapPct: 0.04 }), quote: mkQuote(100.5) },
    verdict: "BLOCK",
    codes: ["GAP_OK", "DISPLAY_MISMATCH"],
  },
  {
    name: "paying >2% over the displayed price at $25 is BLOCK",
    input: { row: mkRow({ perShare: 98, displayedGapPct: -0.02 }), quote: mkQuote(100.5) },
    verdict: "BLOCK",
    codes: ["GAP_OK", "SPREAD_AT_BASE"],
  },
  {
    name: "impact over 1% at $100 is CAUTION",
    input: { row: mkRow(), quote: mkQuote(100.5), ladder: [mkQuote(101.6, { usd: 100 })] },
    verdict: "CAUTION",
    codes: ["GAP_OK", "IMPACT_AT_SIZE"],
  },
  {
    name: "impact under 1% at $100 stays GO",
    input: { row: mkRow(), quote: mkQuote(100.5), ladder: [mkQuote(100.9, { usd: 100 })] },
    verdict: "GO",
    codes: ["GAP_OK"],
  },
  {
    name: "no reference with agreeing venues is CAUTION",
    input: { row: mkRow({ reference: null, displayedGapPct: null, referenceSource: "none" }), quote: mkQuote(100.5) },
    ctx: { venueDisagreementPct: 0.01 },
    verdict: "CAUTION",
    codes: ["NO_REFERENCE"],
  },
  {
    name: "no reference with venues 5% apart is BLOCK",
    input: { row: mkRow({ reference: null, displayedGapPct: null, referenceSource: "none" }), quote: mkQuote(100.5) },
    ctx: { venueDisagreementPct: 0.05 },
    verdict: "BLOCK",
    codes: ["NO_REFERENCE_DISAGREE"],
  },
  { name: "off-hours caps GO at CAUTION", input: { row: mkRow(), quote: mkQuote(100.2) }, ctx: { session: "postmarket" }, verdict: "CAUTION", codes: ["GAP_OK", "OFF_HOURS"] },
  { name: "weekend caps GO at CAUTION", input: { row: mkRow(), quote: mkQuote(100.2) }, ctx: { session: "weekend" }, verdict: "CAUTION", codes: ["GAP_OK", "OFF_HOURS"] },
  { name: "off-hours adds nothing to a BLOCK", input: { row: mkRow(), quote: failQuote }, ctx: { session: "overnight" }, verdict: "BLOCK", codes: ["QUOTE_ERROR"] },
  {
    name: "missing venue status is informational only",
    input: { row: mkRow({ flags: ["STATUS_MISSING"] }), quote: mkQuote(100.2) },
    verdict: "GO",
    codes: ["GAP_OK", "STATUS_MISSING"],
  },
  { name: "worst rule wins", input: { row: mkRow(), quote: mkQuote(101, { ts: NOW - 120_000 }) }, verdict: "BLOCK", codes: ["QUOTE_STALE", "GAP_WIDE"] },
];

describe("evaluateVenue rules", () => {
  it.each(cases)("$name", ({ input, ctx, verdict, codes }) => {
    const out = evaluateVenue(input, { ...regular, ...ctx });
    expect(out.verdict).toBe(verdict);
    expect(out.reasons.map((r) => r.code)).toEqual(codes);
    expect(out.reasons.every((r) => r.message.length > 10 && r.message.endsWith("."))).toBe(true);
  });

  it("is deterministic", () => {
    const input = { row: mkRow(), quote: mkQuote(101), ladder: [mkQuote(102, { usd: 100 })] };
    expect(evaluateVenue(input, regular)).toEqual(evaluateVenue(input, regular));
  });

  it("explains the gap in plain English with both prices", () => {
    const out = evaluateVenue({ row: mkRow(), quote: mkQuote(102) }, regular);
    expect(out.reasons[0]!.message).toBe("Fill is +2.00% off the stock ($102.00 per share vs the stock at $100.00); the limit is ±1.50%.");
  });
});

describe("evaluateTicker", () => {
  const venue = (symbol: string, fill: number | null, platform: MatrixRow["platform"] = "bstocks"): VenueInput => ({
    row: mkRow({ symbol, platform }),
    quote: fill === null ? { ...failQuote, symbol } : mkQuote(fill, { symbol }),
  });

  it("picks GO before CAUTION, then the lowest fill", () => {
    const t = evaluateTicker([venue("A", 100.1), venue("B", 99.9), venue("C", 99.0, "ondo"), venue("D", null, "xstocks")], regular);
    expect(t.venues.map((v) => v.verdict)).toEqual(["GO", "GO", "CAUTION", "BLOCK"]);
    expect(t.bestVenue?.symbol).toBe("B");
  });

  it("returns no best venue when everything is blocked", () => {
    const t = evaluateTicker([venue("A", null), venue("B", 103)], regular);
    expect(t.bestVenue).toBeNull();
    expect(pickBest(t.venues)).toBeNull();
  });

  it("measures cross-venue disagreement from successful quotes only", () => {
    expect(venueDisagreement([mkQuote(100), mkQuote(105), failQuote, null])).toBeCloseTo(0.05, 12);
    expect(venueDisagreement([mkQuote(100), failQuote])).toBeNull();
  });
});

describe("gate on recorded fixtures", () => {
  const venues = fixtureVenues();
  const prices = new Map<string, VenuePrice | Error>(venues.map((v) => [v.address, fixturePrice(v)]));
  const rows = assembleRows(byTicker(venues), prices);
  const check = (ticker: string) => {
    const tickerRows = rows.filter((r) => r.ticker === ticker);
    const inputs = tickerRows.map((row) => ({ row, quote: fixtureQuote(row.symbol, 25, row.reference) as ExecQuote }));
    return evaluateTicker(inputs, { session: "regular", now: QUOTE_TIME + 5_000 });
  };

  it("blocks MSTRx: displayed 11-13% cheap but no liquidity", () => {
    const mstrx = check("MSTR").venues.find((v) => v.symbol === "MSTRx")!;
    expect(mstrx.displayedGapPct!).toBeLessThan(-0.03);
    expect(mstrx.verdict).toBe("BLOCK");
    expect(mstrx.reasons[0]).toMatchObject({ code: "QUOTE_ERROR", message: "Quote failed: no liquidity from any vendor (40374)." });
  });

  it("finds at least one GO or CAUTION venue for NVDA and names a best venue", () => {
    const t = check("NVDA");
    expect(t.venues.some((v) => v.verdict !== "BLOCK")).toBe(true);
    expect(t.bestVenue).not.toBeNull();
    expect(t.venues.find((v) => v.symbol === "NVDAx")!.verdict).toBe("BLOCK");
  });
});

describe("policy", () => {
  it("loads the default policy file", () => {
    expect(DEFAULT_POLICY).toEqual(defaultPolicyJson);
    expect(DEFAULT_POLICY.maxTradeUsd).toBe(25);
  });

  it.each([
    ["a missing field", (({ maxTradeUsd: _m, ...rest }) => rest)(defaultPolicyJson)],
    ["an unknown field", { ...defaultPolicyJson, maxTradeUSD: 25 }],
    ["a percent written as 75 instead of 0.0075", { ...defaultPolicyJson, goMaxGapPct: 75 }],
    ["GO band wider than CAUTION band", { ...defaultPolicyJson, goMaxGapPct: 0.02 }],
    ["a bad verdict", { ...defaultPolicyJson, offHoursMaxVerdict: "MAYBE" }],
  ])("rejects %s", (_name, raw) => {
    expect(() => parsePolicy(raw)).toThrow();
  });
});
