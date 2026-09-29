import { describe, expect, it } from "vitest";
import { DynamicSchema, gapPct, parseDynamic, referenceFor, type Venue } from "../src/index";
import { fixturePrice, venueBySymbol } from "./helpers";

const venue = (over: Partial<Venue> = {}): Venue => ({
  ticker: "TEST",
  platform: "ondo",
  symbol: "TESTon",
  address: "0x0000000000000000000000000000000000000001",
  multiplier: 1,
  ...over,
});

describe("per-share math", () => {
  it("divides token price by the dynamic sharesMultiplier", () => {
    const p = fixturePrice(venueBySymbol("NVDAon"));
    expect(p.multiplierSource).toBe("dynamic");
    expect(p.multiplier).toBeGreaterThan(1);
    expect(p.perShare).toBeCloseTo(p.tokenPrice! / p.multiplier, 10);
  });

  it("prefers the dynamic multiplier over the registry's (the list reports 1 for xStocks)", () => {
    const spyx = venueBySymbol("SPYx");
    expect(spyx.multiplier).toBe(1);
    const p = fixturePrice(spyx);
    expect(p.multiplier).toBeGreaterThan(1.001);
    expect(p.perShare!).toBeLessThan(p.tokenPrice!);
  });

  it("handles a multiplier near 1.0034", () => {
    const p = parseDynamic(venue(), DynamicSchema.parse({ tokenInfo: { price: "338.157804", sharesMultiplier: "1.003376" } }));
    expect(p.perShare).toBeCloseTo(338.157804 / 1.003376, 8);
  });

  it("handles a stock-split multiplier of 10", () => {
    const p = parseDynamic(venue(), DynamicSchema.parse({ tokenInfo: { price: "1000", sharesMultiplier: "10" } }));
    expect(p.perShare).toBe(100);
  });

  it("falls back to the registry multiplier when the dynamic one is missing", () => {
    const p = parseDynamic(venue({ multiplier: 2 }), DynamicSchema.parse({ tokenInfo: { price: "50", sharesMultiplier: null } }));
    expect(p.multiplierSource).toBe("registry");
    expect(p.perShare).toBe(25);
  });

  it("returns null per-share when the token has no price", () => {
    const p = parseDynamic(venue(), DynamicSchema.parse({ tokenInfo: { price: null, sharesMultiplier: "1" } }));
    expect(p.perShare).toBeNull();
  });

  it("parses 40-digit decimal strings", () => {
    const p = parseDynamic(venue(), DynamicSchema.parse({ tokenInfo: { price: "340.130854773880343971531273340675384911", sharesMultiplier: "1" } }));
    expect(p.tokenPrice).toBeCloseTo(340.1308547738803, 9);
  });
});

describe("reference cascade", () => {
  it("prefers Ondo's stockInfo.price", () => {
    const prices = ["NVDAon", "NVDAB", "NVDAx"].map((s) => fixturePrice(venueBySymbol(s)));
    const ref = referenceFor(prices);
    expect(ref.source).toBe("ondo");
    expect(ref.price).toBe(prices[0]!.stockPrice);
  });

  it("uses xStocks when Ondo is unavailable, never bStocks' own price", () => {
    const prices = ["NVDAB", "NVDAx"].map((s) => fixturePrice(venueBySymbol(s)));
    expect(prices[0]!.stockPrice).toBeNull();
    expect(referenceFor(prices).source).toBe("xstocks");
  });

  it("returns none when only bStocks is present (its stockInfo.price is empty)", () => {
    const ref = referenceFor([fixturePrice(venueBySymbol("NVDAB"))]);
    expect(ref).toEqual({ price: null, source: "none" });
  });
});

describe("gapPct", () => {
  it("is positive at a premium and negative at a discount", () => {
    expect(gapPct(101, 100)).toBeCloseTo(0.01);
    expect(gapPct(99, 100)).toBeCloseTo(-0.01);
  });

  it("is null without a usable reference or price", () => {
    expect(gapPct(100, null)).toBeNull();
    expect(gapPct(null, 100)).toBeNull();
    expect(gapPct(100, 0)).toBeNull();
  });
});
