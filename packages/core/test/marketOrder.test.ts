import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Log, type TransactionReceipt } from "viem";
import {
  BawError,
  DEFAULT_POLICY,
  NATIVE_BNB,
  USDT_BSC,
  evaluateVenue,
  executeMarketOrder,
  executeTrade,
  usdQty,
  parseQuote,
  parseSellQuote,
  spentTodayUsd,
  walletFillPerShare,
  writeReceipt,
  type ExecReceipt,
  type GateResult,
  type MarketDeps,
  type MatrixRow,
  type OrderInfo,
  type VenueContext,
} from "../src/index";
import { fixture, venueBySymbol } from "./helpers";

const W = "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65";
const AAPLB = "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A";
const POOL = "0x9999999999999999999999999999999999999999";
const NOW = Date.parse("2026-09-29T17:00:00Z");
const env = { GAP_WALLET_ADDRESS: W } as NodeJS.ProcessEnv;
const HELD = 2859609639909174n;
const SELL_OUT = 947588828918313557n;
const HASH = `0x${"cd".repeat(32)}`;

const sellRec = fixture<{ quotes: Record<string, { amount: string; data: unknown }> }>("sell-quotes.json").quotes.AAPLB!;
const wallet = JSON.parse(fixture<Record<string, string>>("baw-wallet.json").quoteAaplbUsdt!).data as { fromCoinAmount: string; toCoinAmount: string };

const row: MatrixRow = {
  ticker: "AAPL",
  platform: "bstocks",
  symbol: "AAPLB",
  address: AAPLB,
  tokenPrice: 331.34,
  multiplier: 1,
  perShare: 331.34,
  reference: 331.2,
  referenceSource: "ondo",
  displayedGapPct: 331.34 / 331.2 - 1,
  assetStatus: null,
  holders: null,
  flags: ["STATUS_MISSING"],
};
const ctx: VenueContext = { ticker: "AAPL", row, session: "regular" };

const transferLog = (token: string, from: string, to: string, value: bigint): Log =>
  ({
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: from as `0x${string}`, to: to as `0x${string}` } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  }) as unknown as Log;

interface Opts {
  held?: bigint;
  usdt?: bigint;
  bnb?: bigint;
  walletTo?: string;
  statuses?: OrderInfo["status"][];
  swapHash?: string | null;
  gateSession?: VenueContext["session"];
}

function fakeDeps(o: Opts = {}) {
  let clock = NOW;
  const held = o.held ?? HELD;
  const statuses = [...(o.statuses ?? ["FINISHED"])];
  const venue = { ...venueBySymbol("AAPLB"), address: AAPLB, multiplier: 1 };
  const gate = (quote: ReturnType<typeof parseQuote>): GateResult => ({
    ticker: "AAPL",
    row,
    session: o.gateSession ?? "regular",
    verdict: evaluateVenue({ row, quote }, { session: o.gateSession ?? "regular", now: clock }, DEFAULT_POLICY),
    quote,
  });
  const deps: MarketDeps = {
    venue: vi.fn(async () => ctx),
    gateSell: vi.fn(async (_c, qty) => {
      const scaled = (SELL_OUT * qty) / HELD;
      const data = (sellRec.data as Array<Record<string, unknown>>).map((r) => ({ ...r, toTokenAmount: scaled.toString() }));
      return gate(parseSellQuote({ venue, tokenQty: qty, decimals: 18, multiplier: 1, reference: row.reference, ts: clock }, data));
    }),
    gateBuy: vi.fn(async (_c, usd) => {
      const tokens = BigInt(Math.round((usd / 331.3) * 1e18));
      const orig = (sellRec.data as Array<Record<string, unknown>>)[0]!;
      const data = [{ ...orig, toTokenAmount: tokens.toString(), toToken: { ...(orig.toToken as object), tokenSymbol: "AAPLB" } }];
      return gate(parseQuote({ venue, usd, multiplier: 1, reference: row.reference, ts: clock }, data));
    }),
    chain: {
      balance: vi.fn(async (token: string) =>
        token.toLowerCase() === AAPLB.toLowerCase() ? held : token === NATIVE_BNB ? (o.bnb ?? 1_114_125_284_880_510n) : (o.usdt ?? 41_934_267_991_288_669n),
      ),
      allowance: vi.fn(async () => 0n),
      decimals: vi.fn(async () => 18),
      waitForReceipt: vi.fn(async (hash: string) =>
        ({
          transactionHash: hash,
          status: "success",
          blockNumber: 99n,
          gasUsed: 150_000n,
          effectiveGasPrice: 100_000_000n,
          to: POOL,
          logs: [transferLog(AAPLB, W, POOL, HELD), transferLog(USDT_BSC, POOL, W, SELL_OUT - 100_000_000_000_000n)],
        }) as unknown as TransactionReceipt,
      ),
    },
    wallet: {
      quote: vi.fn(async (p) => ({
        fromCoinSymbol: null,
        toCoinSymbol: null,
        slippage: 0.01,
        fromCoinAmount: p.qty,
        toCoinAmount: o.walletTo ?? ((Number(wallet.toCoinAmount) * Number(p.qty)) / Number(wallet.fromCoinAmount)).toFixed(18),
      })),
      swap: vi.fn(async () => ({ id: "7001", status: "PENDING" as const, txHash: null, raw: { orderId: 7001, status: "PENDING" } })),
      order: vi.fn(async (id: string) => {
        const status = statuses.shift() ?? "PENDING";
        return { id, status, txHash: status === "FINISHED" && o.swapHash !== null ? (o.swapHash ?? HASH) : null, raw: { orderId: id, status } };
      }),
    },
    confirm: vi.fn(async () => true),
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    log: () => {},
  };
  return deps;
}

describe("contract-call sells and quantity strings", () => {
  it("executeTrade refuses a sell with SELL_VIA_UNSUPPORTED before touching anything", async () => {
    const gate = vi.fn();
    const { receipt } = await executeTrade("AAPLB", { usd: 1, side: "sell", env, receiptsDir: null, deps: { gate, requote: vi.fn(), api: {} as never, chain: {} as never, overrideSim: vi.fn(), baw: {} as never, confirm: vi.fn(), now: () => NOW, sleep: vi.fn(), log: () => {} } });
    expect(receipt).toMatchObject({ outcome: "REFUSED", side: "sell", via: "contract-call", refusal: { code: "SELL_VIA_UNSUPPORTED" } });
    expect(gate).not.toHaveBeenCalled();
  });

  it("formats USD sizes as plain decimal strings", () => {
    expect(usdQty(1)).toBe("1");
    expect(usdQty(1.5)).toBe("1.5");
    expect(usdQty(0.1 + 0.2)).toBe("0.3");
  });
});

describe("walletFillPerShare", () => {
  it("prices a sell as USDT received per share and a buy as USDT paid per share", () => {
    expect(walletFillPerShare("sell", "0.002859609639909174", "0.947461127952585067", 1)).toBeCloseTo(331.325, 2);
    expect(walletFillPerShare("buy", "1", "0.003", 1)).toBeCloseTo(333.333, 2);
  });
});

describe("executeMarketOrder: sells", () => {
  it("dry run of --all gates the recorded sell, checks the wallet quote and sends nothing", async () => {
    const deps = fakeDeps();
    const { receipt } = await executeMarketOrder("AAPLB", { side: "sell", all: true, env, deps, receiptsDir: null });
    expect(receipt).toMatchObject({ outcome: "SIMULATED", side: "sell", via: "market-order", gate: { verdict: "GO" } });
    expect(receipt.usd).toBeCloseTo(0.9476, 4);
    expect(receipt.walletQuote!.fromQty).toBe("0.002859609639909174");
    expect(Math.abs(receipt.walletQuote!.deviationPct)).toBeLessThan(0.001);
    expect(deps.gateSell).toHaveBeenCalledWith(ctx, HELD, 18, W, DEFAULT_POLICY);
    expect(deps.wallet.swap).not.toHaveBeenCalled();
    expect(receipt.steps.at(-1)!.step).toMatch(/wallet quote checked; not sent/);
  });

  it("live sell polls the order and reads the real fill from Transfer logs", async () => {
    const deps = fakeDeps({ statuses: ["PENDING", "FINISHED"] });
    const { receipt } = await executeMarketOrder("AAPLB", { side: "sell", all: true, live: true, env, deps, receiptsDir: null });
    expect(receipt.outcome).toBe("FILLED");
    expect(deps.wallet.swap).toHaveBeenCalledWith({ fromToken: AAPLB, toToken: USDT_BSC, qty: "0.002859609639909174", slippage: 0.5 });
    expect(deps.wallet.order).toHaveBeenCalledTimes(2);
    expect(receipt.order).toMatchObject({ id: "7001", status: "FINISHED" });
    expect(receipt.swap).toMatchObject({ txHash: HASH, to: POOL });
    expect(receipt.fill).toMatchObject({ usdSpent: 0, source: "transfer-logs" });
    expect(receipt.fill!.tokensOut).toBeCloseTo(0.0028596, 7);
    expect(receipt.fill!.usdReceived).toBeCloseTo(0.94749, 5);
    expect(receipt.fill!.realizedGapPct!).toBeLessThan(0.0075);
  });

  it("falls back to balance changes when the finished order has no tx hash", async () => {
    const deps = fakeDeps({ swapHash: null });
    let calls = 0;
    deps.chain.balance = vi.fn(async (token: string) => {
      if (token.toLowerCase() === AAPLB.toLowerCase()) return calls++ < 1 ? HELD : 0n;
      if (token === NATIVE_BNB) return 10n ** 15n * 2n;
      return calls > 1 ? 41_934_267_991_288_669n + SELL_OUT : 41_934_267_991_288_669n;
    });
    const { receipt } = await executeMarketOrder("AAPLB", { side: "sell", all: true, live: true, env, deps, receiptsDir: null });
    expect(receipt.outcome).toBe("FILLED");
    expect(receipt.fill!.source).toBe("balance-change");
    expect(receipt.swap).toBeNull();
  });

  it("refuses NO_POSITION when the wallet holds none", async () => {
    const { receipt } = await executeMarketOrder("AAPLB", { side: "sell", all: true, env, deps: fakeDeps({ held: 0n }), receiptsDir: null });
    expect(receipt).toMatchObject({ outcome: "REFUSED", refusal: { code: "NO_POSITION" } });
  });

  it("refuses WALLET_QUOTE_MISMATCH when the wallet pays 1% less than the gated quote", async () => {
    const deps = fakeDeps({ walletTo: (0.9476 * 0.99).toFixed(18) });
    const { receipt } = await executeMarketOrder("AAPLB", { side: "sell", all: true, live: true, env, deps, receiptsDir: null });
    expect(receipt).toMatchObject({ outcome: "REFUSED", refusal: { code: "WALLET_QUOTE_MISMATCH" } });
    expect(deps.wallet.swap).not.toHaveBeenCalled();
  });

  it("a swap the wallet refuses is REFUSED and never counted as sent", async () => {
    const deps = fakeDeps();
    deps.wallet.swap = vi.fn(async () => {
      throw new BawError("Insufficient liquidity (7)", { success: false, error: { message: "Insufficient liquidity", code: 7 } });
    });
    const { receipt } = await executeMarketOrder("AAPLB", { side: "sell", all: true, live: true, env, deps, receiptsDir: null });
    expect(receipt).toMatchObject({ outcome: "REFUSED", refusal: { code: "WALLET_REJECTED" } });
    expect(receipt.order).toBeUndefined();
    expect(deps.wallet.order).not.toHaveBeenCalled();
  });

  it("ORDER_FAILED after sending is FAILED, and ORDER_TIMEOUT is PENDING", async () => {
    const failed = await executeMarketOrder("AAPLB", { side: "sell", all: true, live: true, env, deps: fakeDeps({ statuses: ["FAILED"] }), receiptsDir: null });
    expect(failed.receipt).toMatchObject({ outcome: "FAILED", refusal: { code: "ORDER_FAILED" } });
    const slow = await executeMarketOrder("AAPLB", { side: "sell", all: true, live: true, env, deps: fakeDeps({ statuses: [] }), receiptsDir: null });
    expect(slow.receipt).toMatchObject({ outcome: "PENDING", refusal: { code: "ORDER_TIMEOUT" }, order: { id: "7001" } });
  });

  it("off-hours exits are refused (the gate caps them at CAUTION)", async () => {
    const deps = fakeDeps({ gateSession: "overnight" });
    const { receipt } = await executeMarketOrder("AAPLB", { side: "sell", all: true, live: true, env, deps, receiptsDir: null });
    expect(receipt).toMatchObject({ outcome: "REFUSED", refusal: { code: "GATE_NOT_GO" } });
  });

  it("needs exactly one sizing flag, and a declined prompt sends nothing", async () => {
    const bad = await executeMarketOrder("AAPLB", { side: "sell", all: true, qty: "0.001", env, deps: fakeDeps(), receiptsDir: null });
    expect(bad.receipt.refusal!.code).toBe("BAD_SIZE");
    const deps = fakeDeps();
    deps.confirm = vi.fn(async () => false);
    const declined = await executeMarketOrder("AAPLB", { side: "sell", qty: "0.001", live: true, env, deps, receiptsDir: null });
    expect(declined.receipt).toMatchObject({ outcome: "REFUSED", refusal: { code: "USER_DECLINED" } });
    expect(deps.wallet.swap).not.toHaveBeenCalled();
  });

  it("honours the kill switch", async () => {
    const { receipt } = await executeMarketOrder("AAPLB", { side: "sell", all: true, env: { ...env, GAP_EXEC_DISABLED: "1" }, deps: fakeDeps(), receiptsDir: null });
    expect(receipt.refusal!.code).toBe("EXEC_DISABLED");
  });
});

describe("executeMarketOrder: buys and the daily cap", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("a buy dry run checks the wallet quote in the buy direction", async () => {
    const deps = fakeDeps();
    deps.wallet.quote = vi.fn(async (p) => ({ fromCoinSymbol: "USDT", toCoinSymbol: "AAPLB", slippage: 0.01, fromCoinAmount: p.qty, toCoinAmount: (1 / 331.3).toFixed(18) }));
    const { receipt } = await executeMarketOrder("AAPLB", { side: "buy", usd: 1, env, deps, receiptsDir: null });
    expect(receipt.refusal).toBeNull();
    expect(receipt).toMatchObject({ outcome: "SIMULATED", side: "buy", via: "market-order" });
    expect(deps.wallet.quote).toHaveBeenCalledWith({ fromToken: USDT_BSC, toToken: AAPLB, qty: "1", slippage: 0.5 });
  });

  it("sells never count toward the daily spend; limit placements do until cancelled", () => {
    const base = { version: 1, mode: "live", createdAt: new Date(NOW).toISOString(), outcome: "FILLED", usd: 3, fill: null } as unknown as ExecReceipt;
    const receipts: ExecReceipt[] = [
      { ...base, kind: "trade", side: "sell", usd: 4 },
      { ...base, kind: "trade", side: "buy", usd: 1.5 },
      { ...base, kind: "trade", usd: 1 },
      { ...base, kind: "limit", outcome: "PLACED", usd: 1, order: { id: "s1", status: "WORKING", raw: {} } },
      { ...base, kind: "limit", outcome: "PLACED", usd: 2, order: { id: "s2", status: "WORKING", raw: {} } },
      { ...base, kind: "limit", outcome: "CANCELED", usd: 2, order: { id: "s2", status: "CANCELED", raw: {} } },
    ];
    expect(spentTodayUsd(receipts, NOW)).toBeCloseTo(3.5);
  });

  it("live buys are refused over the daily cap; a live sell is not", async () => {
    dir = mkdtempSync(join(tmpdir(), "gap-mo-"));
    writeReceipt(dir, { version: 1, id: "a", kind: "trade", mode: "live", outcome: "FILLED", createdAt: new Date(NOW).toISOString(), usd: 4.5, fill: null } as unknown as ExecReceipt);
    const buy = await executeMarketOrder("AAPLB", { side: "buy", usd: 1, live: true, env, deps: fakeDeps(), receiptsDir: dir });
    expect(buy.receipt.refusal!.code).toBe("DAILY_CAP");
    const sell = await executeMarketOrder("AAPLB", { side: "sell", all: true, live: true, env, deps: fakeDeps(), receiptsDir: dir });
    expect(sell.receipt.outcome).toBe("FILLED");
  });
});
