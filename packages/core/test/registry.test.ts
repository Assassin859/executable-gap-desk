import { describe, expect, it } from "vitest";
import { ListSchema, byTicker, multiVenue, parseRegistry, resolve } from "../src/index";
import { fixture, fixtureVenues } from "./helpers";

describe("registry", () => {
  const venues = fixtureVenues();

  it("keeps only BSC venues of platform types 1-3", () => {
    const raw = ListSchema.parse(fixture("list.json"));
    expect(raw.length).toBe(14);
    expect(venues).toHaveLength(12);
    expect(venues.every((v) => ["ondo", "xstocks", "bstocks"].includes(v.platform))).toBe(true);
    expect(venues.find((v) => v.symbol === "xKLSH")).toBeUndefined();
  });

  it("maps list type to platform", () => {
    const platformOf = (s: string) => venues.find((v) => v.symbol === s)?.platform;
    expect(platformOf("AAPLon")).toBe("ondo");
    expect(platformOf("AAPLx")).toBe("xstocks");
    expect(platformOf("AAPLB")).toBe("bstocks");
  });

  it("orders venues ondo, bstocks, xstocks within a ticker", () => {
    expect(byTicker(venues).get("NVDA")?.map((v) => v.platform)).toEqual(["ondo", "bstocks", "xstocks"]);
  });

  it("groups multi-venue tickers", () => {
    const multi = multiVenue(venues);
    expect([...multi.keys()].sort()).toEqual(["AAPL", "MSTR", "NVDA", "SPY"]);
    expect(multi.get("MSTR")).toHaveLength(3);
  });

  it("excludes single-venue tickers from multiVenue", () => {
    const single = parseRegistry([
      { chainId: "56", contractAddress: "0x1", symbol: "ONEon", ticker: "ONE", type: 1, multiplier: 1 },
      { chainId: "56", contractAddress: "0x2", symbol: "TWOon", ticker: "TWO", type: 1, multiplier: 1 },
      { chainId: "56", contractAddress: "0x3", symbol: "TWOB", ticker: "TWO", type: 3, multiplier: 1 },
    ]);
    expect([...multiVenue(single).keys()]).toEqual(["TWO"]);
  });

  it("defaults a missing or zero multiplier to 1", () => {
    const [v] = parseRegistry([{ chainId: "56", contractAddress: "0x1", symbol: "Xon", ticker: "X", type: 1, multiplier: null }]);
    expect(v?.multiplier).toBe(1);
  });

  describe("resolve", () => {
    it("by ticker, case-insensitive", () => {
      const r = resolve(venues, "nvda");
      expect(r?.matchedBy).toBe("ticker");
      expect(r?.venues.map((v) => v.symbol)).toEqual(["NVDAon", "NVDAB", "NVDAx"]);
    });

    it("by venue symbol", () => {
      const r = resolve(venues, "MSTRx");
      expect(r?.matchedBy).toBe("symbol");
      expect(r?.ticker).toBe("MSTR");
      expect(r?.match?.platform).toBe("xstocks");
    });

    it("by contract address, case-insensitive", () => {
      const nvdab = venues.find((v) => v.symbol === "NVDAB")!;
      const r = resolve(venues, nvdab.address.toUpperCase().replace("0X", "0x"));
      expect(r?.matchedBy).toBe("address");
      expect(r?.match?.symbol).toBe("NVDAB");
    });

    it("prefers an exact symbol over a ticker with the same letters", () => {
      const vs = parseRegistry([
        { chainId: "56", contractAddress: "0xa", symbol: "MUB", ticker: "MU", type: 3, multiplier: 1 },
        { chainId: "56", contractAddress: "0xb", symbol: "MUBon", ticker: "MUB", type: 1, multiplier: 1 },
      ]);
      expect(resolve(vs, "MUB")?.ticker).toBe("MU");
    });

    it("returns null for unknown input", () => {
      expect(resolve(venues, "ZZZZ")).toBeNull();
      expect(resolve(venues, "   ")).toBeNull();
      expect(resolve(venues, "0x0000000000000000000000000000000000000000")).toBeNull();
    });
  });
});
