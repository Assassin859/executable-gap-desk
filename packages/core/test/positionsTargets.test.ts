import { describe, expect, it, vi } from "vitest";
import {
  BawError,
  DEFAULT_POLICY,
  buildPositions,
  cancelSuggested,
  cancelTarget,
  evaluateVenue,
  listTargets,
  openWarnings,
  parseQuote,
  parseSellQuote,
  placeTarget,
  triggerPrice,
  type GateResult,
  type MatrixRow,
  type PositionsDeps,
  type StockPosition,
  type TargetDeps,
  type Venue,
  type VenueContext,
} from "../src/index";
import { fixture } from "./helpers";

const W = "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65";
const AAPLB = "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A";
const NVDAB = "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NOW = Date.parse("2026-09-29T17:00:00Z");
const env = { GAP_WALLET_ADDRESS: W } as NodeJS.ProcessEnv;

const venues: Venue[] = [
  { ticker: "AAPL", platform: "bstocks", symbol: "AAPLB", address: AAPLB, multiplier: 1 },
  { ticker: "NVDA", platform: "bstocks", symbol: "NVDAB", address: NVDAB, multiplier: 1 },
];
const mkRow = (symbol: string, address: string, ticker: string, price: number, o: Partial<MatrixRow> = {}): MatrixRow => ({
  ticker,
  platform: "bstocks",
  symbol,
  address,
  tokenPrice: price,
  multiplier: 1,
  perShare: price,
  reference: price,
  referenceSource: "ondo",
  displayedGapPct: 0,
  assetStatus: null,
  holders: null,
  flags: [],
  ...o,
});
const rows = [mkRow("AAPLB", AAPLB, "AAPL", 331.2), mkRow("NVDAB", NVDAB, "NVDA", 229.4)];
const sellData = (usdt: bigint) => [{ ...(fixture<{ quotes: Record<string, { data: Array<Record<string, unknown>> }> }>("sell-quotes.json").quotes.AAPLB!.data[0]), toTokenAmount: usdt.toString() }];
const balances = JSON.parse(fixture<Record<string, string>>("baw-wallet.json").balance!).data;

function positionsDeps(over: Partial<PositionsDeps> = {}, fillFactor = 1): PositionsDeps {
  return {
    balance: vi.fn(async () => balances),
    quota: vi.fn(async () => ({ quotaUsed: 0, quotaLeft: 50000, dailyLimit: 50000, date: "2026-09-29" })),
    registry: vi.fn(async () => venues),
    matrix: vi.fn(async () => ({ rows, session: null })),
    gateSell: vi.fn(async (ctx: VenueContext, qty: bigint) => {
      const usdt = BigInt(Math.round(Number(qty) * ctx.row.reference! * fillFactor));
      const v = { ...venues.find((x) => x.symbol === ctx.row.symbol)! };
      const quote = parseSellQuote({ venue: v, tokenQty: qty, decimals: 18, multiplier: 1, reference: ctx.row.reference, ts: NOW }, sellData(usdt));
      return { ticker: ctx.ticker, row: ctx.row, session: "regular", verdict: evaluateVenue({ row: ctx.row, quote }, { session: "regular", now: NOW }), quote } as GateResult;
    }),
    decimals: vi.fn(async () => 18),
    now: () => NOW,
    ...over,
  };
}

describe("buildPositions", () => {
  it("matches stock tokens to venues, sells each full position through the gate and totals it", async () => {
    const p = await buildPositions(W, positionsDeps());
    expect(p.stocks.map((s) => s.symbol)).toEqual(["AAPLB", "NVDAB"]);
    expect(p.other.map((o) => o.symbol).sort()).toEqual(["BNB", "USDT"]);
    const aapl = p.stocks[0]!;
    expect(aapl.qty).toBe("0.002859609639909174");
    expect(aapl.exit.verdict).toBe("GO");
    expect(aapl.exit.usd).toBeCloseTo(0.002859609639909174 * 331.2, 6);
    expect(p.totals.exitNow).toBeCloseTo(p.totals.stock, 3);
    expect(p.quota?.quotaLeft).toBe(50000);
    expect(p.warnings).toEqual([]);
  });

  it("sizes from the on-chain balance when one is given, and skips empty positions", async () => {
    const p = await buildPositions(W, positionsDeps({ tokenBalance: vi.fn(async (t: string) => (t === AAPLB ? 2857883746551181n : 0n)) }));
    expect(p.stocks.map((s) => s.symbol)).toEqual(["AAPLB"]);
    expect(p.stocks[0]!.qty).toBe("0.002857883746551181");
  });

  it("flags a BLOCK exit when selling would receive more than 1.5% under the stock", async () => {
    const p = await buildPositions(W, positionsDeps({}, 0.98));
    expect(p.stocks.every((s) => s.exit.verdict === "BLOCK")).toBe(true);
    expect(p.warnings).toHaveLength(2);
    expect(p.warnings[0]).toMatch(/AAPLB: exit is BLOCK/);
  });
});

describe("openWarnings", () => {
  const go = { symbol: "AAPLB", exit: { verdict: "GO" } } as StockPosition;
  const caution = { symbol: "AAPLB", exit: { verdict: "CAUTION", reasons: [] } } as unknown as StockPosition;
  it("warns within 60 minutes of the open outside the regular session", () => {
    const soon = { name: "premarket", open: true, nextOpen: new Date(NOW + 45 * 60_000).toISOString(), nextClose: null };
    expect(openWarnings(soon, [caution], NOW)[0]).toMatch(/open is in 45 min.*exit is currently CAUTION/);
    expect(openWarnings({ ...soon, nextOpen: new Date(NOW + 90 * 60_000).toISOString() }, [caution], NOW)).toEqual([]);
    expect(openWarnings({ ...soon, name: "regular" }, [go], NOW)).toEqual([]);
    expect(openWarnings(soon, [], NOW)).toEqual([]);
  });
});

function targetDeps(o: { walletPx?: number; verdictRow?: Partial<MatrixRow>; orders?: Array<Record<string, unknown>> } = {}) {
  const row = mkRow("AAPLB", AAPLB, "AAPL", 331.2, o.verdictRow);
  const ctx: VenueContext = { ticker: "AAPL", row, session: "regular" };
  const deps: TargetDeps = {
    venue: vi.fn(async () => ctx),
    gateBuy: vi.fn(async (c: VenueContext, usd: number) => {
      const tokens = BigInt(Math.round((usd / 331.3) * 1e18));
      const d = sellData(0n)[0]!;
      const quote = parseQuote({ venue: venues[0]!, usd, multiplier: 1, reference: c.row.reference, ts: NOW }, [{ ...d, toTokenAmount: tokens.toString() }]);
      return { ticker: "AAPL", row: c.row, session: "regular", verdict: evaluateVenue({ row: c.row, quote }, { session: "regular", now: NOW }), quote } as GateResult;
    }),
    wallet: {
      quote: vi.fn(async (p) => ({ fromCoinSymbol: "USDT", toCoinSymbol: "AAPLB", slippage: 0.01, fromCoinAmount: p.qty, toCoinAmount: (Number(p.qty) / (o.walletPx ?? 331.4)).toFixed(18) })),
      limitBuy: vi.fn(async () => ({ id: "s-42", status: "WORKING" as const, txHash: null, raw: { strategyId: "s-42" } })),
      limitOrders: vi.fn(async () =>
        (o.orders ?? []).map((raw) => ({ id: String(raw.strategyId), status: "WORKING" as const, txHash: null, raw })),
      ),
      limitCancel: vi.fn(async () => true),
    },
    registry: vi.fn(async () => venues),
    confirm: vi.fn(async () => true),
    now: () => NOW,
    log: () => {},
  };
  return deps;
}

describe("gap target", () => {
  it("trigger is the stock price per token less the discount", () => {
    expect(triggerPrice(331.2, 1, 2)).toBeCloseTo(324.576, 6);
    expect(triggerPrice(100, 1.05, 0.25)).toBeCloseTo(104.7375, 6);
  });

  it("dry run on a GO venue sets the trigger under the market and places nothing", async () => {
    const deps = targetDeps();
    const { receipt } = await placeTarget("AAPLB", { usd: 1, discountPct: 2, env, deps, receiptsDir: null });
    expect(receipt).toMatchObject({ kind: "limit", outcome: "SIMULATED", limit: { discountPct: 2, qty: "1" } });
    expect(receipt.limit!.triggerPriceUsd).toBeCloseTo(324.576, 3);
    expect(deps.wallet.limitBuy).not.toHaveBeenCalled();
  });

  it("live places the limit buy and records PLACED with the strategy id", async () => {
    const deps = targetDeps();
    const { receipt } = await placeTarget("AAPLB", { usd: 1, discountPct: 2, live: true, env, deps, receiptsDir: null });
    expect(receipt).toMatchObject({ outcome: "PLACED", order: { id: "s-42" } });
    expect(deps.wallet.limitBuy).toHaveBeenCalledWith({ triggerPriceUsd: receipt.limit!.triggerPriceUsd, fromToken: USDT, toToken: AAPLB, qty: "1", slippage: 0.5 });
    expect(receipt.id).toMatch(/-limit-AAPLB$/);
  });

  it("a wallet rejection is REFUSED with nothing placed; an unreadable reply stays FAILED", async () => {
    const deps = targetDeps();
    deps.wallet.limitBuy = vi.fn(async () => {
      throw new BawError("Raw limit orders are not supported. (2)", { success: false, error: { message: "Raw limit orders are not supported.", code: 2 } });
    });
    const { receipt } = await placeTarget("AAPLB", { usd: 1, discountPct: 2, live: true, env, deps, receiptsDir: null });
    expect(receipt).toMatchObject({ outcome: "REFUSED", refusal: { code: "WALLET_REJECTED" } });
    expect(receipt.refusal!.message).toMatch(/Raw limit orders are not supported/);
    deps.wallet.limitBuy = vi.fn(async () => {
      throw new BawError("baw returned no JSON (exit 1): timed out");
    });
    const odd = await placeTarget("AAPLB", { usd: 1, discountPct: 2, live: true, env, deps, receiptsDir: null });
    expect(odd.receipt.outcome).toBe("FAILED");
  });

  it("refuses TRIGGER_AT_MARKET when the trigger would fill at once", async () => {
    const { receipt } = await placeTarget("AAPLB", { usd: 1, discountPct: 0, env, deps: targetDeps({ walletPx: 330 }), receiptsDir: null });
    expect(receipt.refusal!.code).toBe("TRIGGER_AT_MARKET");
  });

  it("refuses when the venue is not GO, and over the $10 cap", async () => {
    const block = await placeTarget("AAPLB", { usd: 1, env, deps: targetDeps({ verdictRow: { reference: 320 } }), receiptsDir: null });
    expect(block.receipt.refusal!.code).toBe("GATE_NOT_GO");
    const big = await placeTarget("AAPLB", { usd: 11, env, deps: targetDeps(), receiptsDir: null });
    expect(big.receipt.refusal).toMatchObject({ code: "SIZE_OVER_CAP" });
    expect(DEFAULT_POLICY.maxLimitOrderUsd).toBe(10);
  });

  it("targets re-gates WORKING orders and suggests cancelling when the venue turned BLOCK", async () => {
    const orders = [{ strategyId: "s-1", toToken: AAPLB, fromTokenQty: "1", triggerPrice: "324.5" }];
    const ok = await listTargets({ env, deps: targetDeps({ orders }) });
    expect(ok[0]).toMatchObject({ symbol: "AAPLB", usd: 1, triggerPriceUsd: 324.5, verdict: "GO", cancelSuggested: false });
    const bad = await listTargets({ env, deps: targetDeps({ orders, verdictRow: { perShare: 350, displayedGapPct: 0.057 } }) });
    expect(bad[0]).toMatchObject({ verdict: "BLOCK", cancelSuggested: true });
  });

  it("cancelSuggested covers an unreachable venue", () => {
    expect(cancelSuggested(null)).toEqual({ suggested: true, why: "the venue could not be re-gated" });
  });

  it("cancel is a dry run by default and CANCELED when live", async () => {
    const orders = [{ strategyId: "s-1", toToken: AAPLB, fromTokenQty: "1", triggerPrice: "324.5" }];
    const deps = targetDeps({ orders });
    const dry = await cancelTarget("s-1", { env, deps, receiptsDir: null });
    expect(dry.receipt.outcome).toBe("SIMULATED");
    expect(deps.wallet.limitCancel).not.toHaveBeenCalled();
    const live = await cancelTarget("s-1", { live: true, env, deps, receiptsDir: null });
    expect(live.receipt).toMatchObject({ kind: "limit", outcome: "CANCELED", symbol: "AAPLB", usd: 1, order: { id: "s-1", status: "CANCELED" } });
    expect(deps.wallet.limitCancel).toHaveBeenCalledWith("s-1");
  });
});
