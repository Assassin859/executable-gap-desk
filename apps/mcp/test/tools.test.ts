import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleRows,
  byTicker,
  checkTicker,
  ladderImpact,
  MarketStatusSchema,
  normalizeMarketStatus,
  type ExecQuote,
  type MatrixResult,
  type Positions,
  type VenuePrice,
} from "@gapdesk/core";
import { QUOTE_TIME, fixture, fixturePrice, fixtureQuote, fixtureVenues } from "../../../packages/core/test/helpers";
import { callTool, INPUTS, MAX_USD, TOOLS, ToolInputError, type McpDeps } from "../src/tools";

const venues = fixtureVenues();
const session = normalizeMarketStatus(MarketStatusSchema.parse(fixture("market-status.json")), QUOTE_TIME);
const matrix = (tickers?: string[]): MatrixResult => {
  const vs = tickers?.length ? venues.filter((v) => tickers.includes(v.ticker)) : venues;
  const rows = assembleRows(byTicker(vs), new Map<string, VenuePrice | Error>(vs.map((v) => [v.address, fixturePrice(v)])));
  return { builtAt: QUOTE_TIME, elapsedMs: 1, session, rows, summary: { tickers: 0, venues: rows.length, flagged: 0, errors: 0 } };
};

function fakeDeps(over: Partial<McpDeps> = {}) {
  const calls: string[] = [];
  const quote = async (v: { symbol: string }, usd: number, o: { reference?: number | null }): Promise<ExecQuote> => {
    calls.push(`quote ${v.symbol}@${usd}`);
    return fixtureQuote(v.symbol, usd, o.reference ?? null);
  };
  const deps: McpDeps = {
    registry: async () => venues,
    marketSession: async () => session,
    assetStatus: async () => ({ open: true, session: "regular", reasonCode: null, reasonMsg: null, nextOpen: null, nextClose: null, sessionMissing: false }),
    matrix: async (ticker) => matrix([ticker]),
    ladder: async (v, sizes, o) => {
      const quotes = await Promise.all(sizes.map((s) => quote(v, s, o)));
      return { symbol: v.symbol, quotes, impactPct: ladderImpact(quotes) };
    },
    checkTicker: (ticker, opts) => checkTicker(ticker, { ...opts, now: () => QUOTE_TIME + 5_000, deps: { buildMatrix: async (o) => matrix(o.tickers), getQuote: quote } }),
    positions: async (wallet) => {
      calls.push(`positions ${wallet}`);
      return { wallet, stocks: [] } as unknown as Positions;
    },
    wallet: () => "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65",
    now: () => QUOTE_TIME,
    ...over,
  };
  return { deps, calls };
}

describe("MCP tools", () => {
  it("exposes exactly the five read-only tools", () => {
    expect(Object.keys(TOOLS).sort()).toEqual(["check_gate", "get_market_state", "positions", "quote_route", "resolve"]);
    expect(Object.keys(INPUTS).sort()).toEqual(Object.keys(TOOLS).sort());
  });

  it("resolve returns every venue of a ticker, and the matched venue for a symbol", async () => {
    const { deps } = fakeDeps();
    const byTickerOut = (await callTool("resolve", { query: "NVDA" }, deps)) as { ticker: string; match: string | null; venues: Array<{ symbol: string }> };
    expect(byTickerOut.ticker).toBe("NVDA");
    expect(byTickerOut.match).toBeNull();
    expect(byTickerOut.venues.length).toBeGreaterThanOrEqual(2);
    const bySymbol = (await callTool("resolve", { query: "NVDAB" }, deps)) as { match: string | null };
    expect(bySymbol.match).toBe("NVDAB");
    await expect(callTool("resolve", { query: "ZZZZ" }, deps)).rejects.toThrow(ToolInputError);
  });

  it("get_market_state returns the public session and optional per-venue status", async () => {
    const { deps } = fakeDeps();
    const out = (await callTool("get_market_state", { asset: "NVDA" }, deps)) as { session: { session: string }; assets: unknown[] };
    expect(out.session.session).toBe(session.session);
    expect(out.assets.length).toBeGreaterThanOrEqual(2);
    const bare = (await callTool("get_market_state", {}, deps)) as { assets?: unknown };
    expect(bare.assets).toBeUndefined();
  });

  it("quote_route quotes one venue, sorted and de-duplicated, without quote ids or approve targets", async () => {
    const { deps, calls } = fakeDeps();
    const out = (await callTool("quote_route", { symbol: "NVDAB", usd: [100, 25, 25] }, deps)) as { symbol: string; quotes: Array<Record<string, unknown>> };
    expect(out.symbol).toBe("NVDAB");
    expect(calls).toEqual(["quote NVDAB@25", "quote NVDAB@100"]);
    for (const q of out.quotes) {
      expect(q).not.toHaveProperty("quoteId");
      expect(q).not.toHaveProperty("approveTarget");
    }
    await expect(callTool("quote_route", { symbol: "NVDA" }, deps)).rejects.toThrow(/pass one venue/);
  });

  it("check_gate returns verdicts per venue in the web desk's public shape", async () => {
    const { deps } = fakeDeps();
    const out = (await callTool("check_gate", { ticker: "NVDAB" }, deps)) as { ticker: { ticker: string; usd: number; venues: Array<{ verdict: string; quote: Record<string, unknown> | null }> } };
    expect(out.ticker.ticker).toBe("NVDA");
    expect(out.ticker.usd).toBe(25);
    for (const v of out.ticker.venues) {
      expect(["GO", "CAUTION", "BLOCK"]).toContain(v.verdict);
      if (v.quote) expect(v.quote).not.toHaveProperty("quoteId");
    }
  });

  it("rejects bad tickers, oversized or too many sizes, and unknown fields", async () => {
    const { deps, calls } = fakeDeps();
    await expect(callTool("check_gate", { ticker: "NVDA; rm -rf" }, deps)).rejects.toThrow(ToolInputError);
    await expect(callTool("check_gate", { ticker: "NVDA", usd: MAX_USD + 1 }, deps)).rejects.toThrow(ToolInputError);
    await expect(callTool("check_gate", { ticker: "NVDA", usd: -5 }, deps)).rejects.toThrow(ToolInputError);
    await expect(callTool("quote_route", { symbol: "NVDAB", usd: [1, 2, 3, 4, 5, 6] }, deps)).rejects.toThrow(ToolInputError);
    await expect(callTool("check_gate", { ticker: "NVDA", execute: true }, deps)).rejects.toThrow(ToolInputError);
    expect(calls).toEqual([]);
  });

  it("positions needs a valid wallet address and passes it through", async () => {
    const ok = fakeDeps();
    await callTool("positions", {}, ok.deps);
    expect(ok.calls).toEqual(["positions 0x623dF829DF5cf33506a0fbb152dbc885d5b61C65"]);
    const none = fakeDeps({ wallet: () => undefined });
    await expect(callTool("positions", {}, none.deps)).rejects.toThrow(/GAP_WALLET_ADDRESS/);
  });

  it("never imports anything that signs, sends or executes", () => {
    const src = ["tools.ts", "server.ts"].map((f) => readFileSync(resolvePath(__dirname, "../src", f), "utf8")).join("\n");
    for (const banned of ["executeTrade", "executeMarketOrder", "registerIdentity", "marketSwap", "limitOrder", "createBawRunner", "contract-call", "payX402", "signTypedData", "sendTransaction"]) {
      expect(src).not.toContain(banned);
    }
  });
});
