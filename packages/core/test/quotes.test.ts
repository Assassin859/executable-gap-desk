import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  QUOTE_REASON_BY_CODE,
  getQuote,
  ladderImpact,
  parseQuote,
  passthroughLimiter,
  quoteFromError,
  quotePath,
  usdToBaseUnits,
  USDT_BSC,
  type QuoteOk,
} from "../src/index";
import { fixtureQuote, rawQuote, venueBySymbol } from "./helpers";

const NVDA_REF = 229.995;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("amounts and paths", () => {
  it("converts USD sizes to exact 18-decimal base units", () => {
    expect(usdToBaseUnits(25)).toBe("25000000000000000000");
    expect(usdToBaseUnits(0.5)).toBe("500000000000000000");
    expect(usdToBaseUnits(12.345678)).toBe("12345678000000000000");
    expect(usdToBaseUnits(25, 6)).toBe("25000000");
  });

  it("builds the quote path with chain, USDT, token, amount and wallet", () => {
    const p = quotePath("0xabc", 25, "0xwallet");
    const [path, query] = p.split("?");
    expect(path).toBe("/api/v1/dex/aggregator/quote");
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      binanceChainId: "56",
      fromTokenAddress: USDT_BSC,
      toTokenAddress: "0xabc",
      amount: "25000000000000000000",
      userWalletAddress: "0xwallet",
    });
    expect(quotePath("0xabc", 25)).not.toContain("userWalletAddress");
  });
});

describe("parseQuote", () => {
  it("computes tokens out, per-token and per-share fill, and the executable gap", () => {
    const raw = rawQuote("NVDAB", 25);
    if (!raw.ok) throw new Error("fixture should be ok");
    const toTokenAmount = BigInt((raw.data as Array<{ toTokenAmount: string }>)[0]!.toTokenAmount);
    const q = fixtureQuote("NVDAB", 25, NVDA_REF) as QuoteOk;
    expect(q.ok).toBe(true);
    expect(q.tokensOut).toBeCloseTo(Number(toTokenAmount) / 1e18, 15);
    expect(q.fillPerToken).toBeCloseTo(25 / q.tokensOut, 9);
    expect(q.fillPerShare).toBeCloseTo(25 / (q.tokensOut * q.multiplier), 9);
    expect(q.multiplier).not.toBe(1);
    expect(q.executableGapPct).toBeCloseTo((q.fillPerShare - NVDA_REF) / NVDA_REF, 12);
    expect(Math.abs(q.executableGapPct!)).toBeLessThan(0.01);
    expect(q.executionMode).toBe("SWAP");
    expect(q.vendorName).toBe("LiquidMesh");
    expect(q.route[0]).toBe("USDT");
    expect(q.route.at(-1)).toBe("NVDAB");
    expect(q.networkFeeUsd).toBeGreaterThan(0);
    expect(q.networkFeeUsd).toBeLessThan(0.1);
  });

  it("leaves the executable gap null without a reference", () => {
    const q = fixtureQuote("AAPLon", 25, null) as QuoteOk;
    expect(q.ok).toBe(true);
    expect(q.reference).toBeNull();
    expect(q.executableGapPct).toBeNull();
  });

  it("returns ZERO_OUTPUT for no routes or a zero amount", () => {
    const ctx = { venue: venueBySymbol("NVDAB"), usd: 25 };
    expect(parseQuote(ctx, [])).toMatchObject({ ok: false, reason: "ZERO_OUTPUT" });
    expect(parseQuote(ctx, [{ fromTokenAmount: "1", toTokenAmount: "0" }])).toMatchObject({ ok: false, reason: "ZERO_OUTPUT" });
  });

  it("prefers the route flagged isBest, else the largest output", () => {
    const ctx = { venue: { symbol: "T", address: "0x", multiplier: 1 }, usd: 10 };
    const a = { fromTokenAmount: "1", toTokenAmount: "5000000000000000000", vendorName: "A" };
    const b = { fromTokenAmount: "1", toTokenAmount: "4000000000000000000", vendorName: "B" };
    expect((parseQuote(ctx, [b, a]) as QuoteOk).vendorName).toBe("A");
    expect((parseQuote(ctx, [a, { ...b, isBest: true }]) as QuoteOk).vendorName).toBe("B");
  });
});

describe("quote errors", () => {
  it("maps the recorded xStocks failure to NO_LIQUIDITY", () => {
    expect(fixtureQuote("MSTRx", 25, 155)).toMatchObject({ ok: false, reason: "NO_LIQUIDITY", code: 40374 });
  });

  it.each([
    [40374, "NO_LIQUIDITY"],
    [40367, "ONDO_MARKET_CLOSED"],
    [40369, "BSTOCK_MARKET_CLOSED"],
    [40375, "BELOW_MIN_ORDER"],
    [40366, "OVER_MAX_ORDER"],
    [40368, "BAD_PAIR"],
    [40370, "BAD_PAIR"],
    [50000, "UNKNOWN_ERROR"],
  ])("maps %s to %s", (code, reason) => {
    const err = new ApiError({ endpoint: "/quote", httpStatus: 200, code, msg: "x" });
    expect(quoteFromError({ venue: venueBySymbol("NVDAB"), usd: 25 }, err).reason).toBe(reason);
  });

  it("covers every documented RWA quote code", () => {
    expect(Object.keys(QUOTE_REASON_BY_CODE).sort()).toEqual(["40366", "40367", "40368", "40369", "40370", "40374", "40375"]);
  });
});

describe("ladderImpact", () => {
  it("measures per-share cost against the smallest size", () => {
    const quotes = [25, 100, 500].map((usd) => fixtureQuote("NVDAB", usd, NVDA_REF));
    const impact = ladderImpact(quotes);
    expect(impact[25]).toBe(0);
    expect(impact[100]).toBeGreaterThanOrEqual(0);
    expect(impact[500]!).toBeGreaterThanOrEqual(impact[100]!);
    expect(impact[500]!).toBeLessThan(0.01);
  });

  it("gives null for failed sizes", () => {
    const impact = ladderImpact([fixtureQuote("NVDAB", 25, NVDA_REF), fixtureQuote("MSTRx", 25, 155)].map((q, i) => ({ ...q, usd: i ? 100 : 25 })));
    expect(impact[100]).toBeNull();
  });
});

describe("getQuote", () => {
  const creds = { apiKey: "k", apiSecret: "s" };

  it("signs the request and parses a success", async () => {
    const raw = rawQuote("NVDAB", 25);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, msg: "success", data: raw.ok ? raw.data : null })));
    vi.stubGlobal("fetch", fetchMock);
    const q = await getQuote(venueBySymbol("NVDAB"), 25, { creds, wallet: "0xw", reference: NVDA_REF, limiter: passthroughLimiter });
    expect(q.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith("https://web3.binance.com/build/api/v1/dex/aggregator/quote?")).toBe(true);
    expect(url).toContain("userWalletAddress=0xw");
    expect((init.headers as Record<string, string>)["X-OC-APIKEY"]).toBe("k");
  });

  it("turns an error envelope into a failed quote instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 40374, msg: "Insufficient liquidity", data: null, success: false }))),
    );
    const q = await getQuote(venueBySymbol("MSTRx"), 25, { creds, limiter: passthroughLimiter });
    expect(q).toMatchObject({ ok: false, reason: "NO_LIQUIDITY", code: 40374, message: "Insufficient liquidity" });
  });
});
