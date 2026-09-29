import { describe, expect, it, vi } from "vitest";
import {
  evaluateTicker,
  evaluateVenue,
  getSellQuote,
  parseSellQuote,
  passthroughLimiter,
  pickBest,
  sellQuotePath,
  USDT_BSC,
  type GateContext,
  type MatrixRow,
  type QuoteOk,
  type VenueVerdict,
} from "../src/index";
import { fixture, fixturePrice, venueBySymbol } from "./helpers";

const NOW = 1_800_000_000_000;
const regular: GateContext = { session: "regular", now: NOW };

type SellFixture = { ok: true; amount: string; data: unknown };
const sellFixture = (sym: string) => fixture<{ quotes: Record<string, SellFixture> }>("sell-quotes.json").quotes[sym]!;

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

const sellQuote = (fillPerShare: number, o: Partial<QuoteOk> = {}): QuoteOk => ({
  symbol: "TESTB",
  address: "0xtest",
  usd: 5,
  ts: NOW,
  source: "binance-aggregator",
  side: "sell",
  ok: true,
  tokensOut: 5 / fillPerShare,
  tokensIn: 5 / fillPerShare,
  multiplier: 1,
  fillPerToken: fillPerShare,
  fillPerShare,
  reference: 100,
  executableGapPct: (fillPerShare - 100) / 100,
  executionMode: "SWAP",
  vendorName: "LiquidMesh",
  route: ["TESTB", "USDT"],
  protocols: ["X"],
  vendorPriceImpact: 0,
  networkFeeUsd: 0.02,
  gasLimit: 450000,
  quoteId: null,
  routeCount: 1,
  approveTarget: null,
  tokenDecimals: 18,
  ...o,
});

describe("parseSellQuote on recorded token->USDT quotes", () => {
  it("AAPLB: USDT received, tokens sold and price received per share", () => {
    const f = sellFixture("AAPLB");
    const venue = venueBySymbol("AAPLB");
    const q = parseSellQuote({ venue, tokenQty: BigInt(f.amount), decimals: 18, multiplier: fixturePrice(venue).multiplier, reference: 331, ts: NOW }, f.data);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.side).toBe("sell");
    expect(q.usd).toBeCloseTo(0.947588828918313557, 12);
    expect(q.tokensIn).toBeCloseTo(0.002859609639909174, 15);
    expect(q.fillPerShare).toBeCloseTo(q.usd / (q.tokensIn! * q.multiplier), 9);
    expect(q.fillPerShare).toBeGreaterThan(300);
    expect(q.executableGapPct).toBeCloseTo((q.fillPerShare - 331) / 331, 9);
    expect(q.route.at(-1)).toBe("USDT");
    expect(q.executionMode).toBe("SWAP");
  });

  it("NVDAB routes through several hops to USDT", () => {
    const f = sellFixture("NVDAB");
    const q = parseSellQuote({ venue: venueBySymbol("NVDAB"), tokenQty: BigInt(f.amount), decimals: 18, reference: null, ts: NOW }, f.data);
    expect(q.ok && q.usd).toBeCloseTo(1.502420375017853474, 12);
    expect(q.ok && q.route.length).toBeGreaterThan(2);
    expect(q.ok && q.executableGapPct).toBeNull();
  });

  it("zero output and empty routes are failures tagged as sells", () => {
    const venue = venueBySymbol("AAPLB");
    const q = parseSellQuote({ venue, tokenQty: 10n ** 15n, decimals: 18 }, []);
    expect(q).toMatchObject({ ok: false, reason: "ZERO_OUTPUT", side: "sell" });
  });

  it("the path sells the token for USDT with the exact base-unit amount", () => {
    const p = new URLSearchParams(sellQuotePath("0xabc", 2859609639909174n, "0xw").split("?")[1]);
    expect(p.get("fromTokenAddress")).toBe("0xabc");
    expect(p.get("toTokenAddress")).toBe(USDT_BSC);
    expect(p.get("amount")).toBe("2859609639909174");
    expect(p.get("userWalletAddress")).toBe("0xw");
  });

  it("getSellQuote maps API errors to a sell QuoteFail", async () => {
    const venue = venueBySymbol("AAPLB");
    const creds = { apiKey: "k", apiSecret: "s" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "40369", message: "closed", success: false }), { status: 200 })));
    try {
      const q = await getSellQuote(venue, 10n ** 15n, 18, { creds, limiter: passthroughLimiter, wallet: "0xw" });
      expect(q).toMatchObject({ ok: false, side: "sell", reason: "BSTOCK_MARKET_CLOSED" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("sell-side gate", () => {
  it("SPREAD_AT_BASE fires when you receive more than 2% under the displayed price", () => {
    const v = evaluateVenue({ row: mkRow({ perShare: 103, reference: 100, displayedGapPct: 0.03 }), quote: sellQuote(100.5) }, regular);
    expect(v.reasons.map((r) => r.code)).toContain("SPREAD_AT_BASE");
    expect(v.reasons.find((r) => r.code === "SPREAD_AT_BASE")!.message).toMatch(/you receive .* under/);
    expect(v.verdict).toBe("BLOCK");
  });

  it("receiving above the displayed price is not a spread problem on a sell", () => {
    const v = evaluateVenue({ row: mkRow({ perShare: 99.8 }), quote: sellQuote(100.2) }, regular);
    expect(v.reasons.map((r) => r.code)).not.toContain("SPREAD_AT_BASE");
    expect(v.verdict).toBe("GO");
    expect(v.reasons.find((r) => r.code === "GAP_OK")!.message).toMatch(/^You receive \+0\.20% vs the stock/);
  });

  it("skips IMPACT_AT_SIZE for sells even with a steep ladder", () => {
    const ladder = [sellQuote(90, { usd: 100 })];
    const v = evaluateVenue({ row: mkRow(), quote: sellQuote(100), ladder }, regular);
    expect(v.reasons.map((r) => r.code)).not.toContain("IMPACT_AT_SIZE");
    expect(v.impactPct).toEqual({});
  });

  it("gap bands and off-hours apply to sells the same way", () => {
    expect(evaluateVenue({ row: mkRow(), quote: sellQuote(98.2) }, regular).verdict).toBe("BLOCK");
    expect(evaluateVenue({ row: mkRow(), quote: sellQuote(99.0) }, regular).verdict).toBe("CAUTION");
    expect(evaluateVenue({ row: mkRow(), quote: sellQuote(99.9) }, { session: "overnight", now: NOW }).verdict).toBe("CAUTION");
  });

  it("pickBest takes the highest price received for a sell and the lowest paid for a buy", () => {
    const v = (symbol: string, fillPerShare: number): VenueVerdict => ({
      symbol, platform: "bstocks", verdict: "GO", reasons: [], fillPerShare, executableGapPct: 0, displayedGapPct: 0, impactPct: {}, quote: null,
    });
    const venues = [v("A", 99.9), v("B", 100.3)];
    expect(pickBest(venues, "sell")!.symbol).toBe("B");
    expect(pickBest(venues, "buy")!.symbol).toBe("A");
    expect(pickBest(venues)!.symbol).toBe("A");
  });

  it("evaluateTicker picks by side from the quotes", () => {
    const t = evaluateTicker(
      [
        { row: mkRow({ symbol: "AB" }), quote: sellQuote(99.9, { symbol: "AB" }) },
        { row: mkRow({ symbol: "CB" }), quote: sellQuote(100.2, { symbol: "CB" }) },
      ],
      regular,
    );
    expect(t.bestVenue!.symbol).toBe("CB");
  });
});
