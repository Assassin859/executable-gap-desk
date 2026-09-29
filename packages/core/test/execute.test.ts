import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type Log, type TransactionReceipt } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_UINT256 } from "../src/chain";
import { USDT_BSC } from "../src/config";
import {
  executeTrade,
  fundUsdt,
  listReceipts,
  spentTodayUsd,
  writeReceipt,
  type ExecDeps,
  type ExecReceipt,
  type GateResult,
} from "../src/execute";
import { DEFAULT_POLICY, evaluateVenue } from "../src/gate";
import type { MatrixRow } from "../src/matrix";
import { parseQuote } from "../src/quotes";
import { ApproveResponseSchema, QuoteResponseSchema, SimulateResponseSchema, SwapResponseSchema } from "../src/schemas";
import type { SessionName } from "../src/session";
import { NATIVE_BNB } from "../src/trade";

const trade = JSON.parse(readFileSync(resolve(__dirname, "fixtures/trade.json"), "utf8"));
const raw = (k: string) => trade.calls[k].data;
const W = trade.wallet as string;
const ROUTER = "0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const NOW = Date.parse("2026-09-29T15:30:00Z");
const MULT = 1.0007782237528078;
const SWAP = SwapResponseSchema.parse(raw("usdtNvdab.swap"));
const OUT = BigInt(SWAP.routerResult!.toTokenAmount!);
const USD = 1.5;
const AMOUNT = 1_500_000_000_000_000_000n;

const row: MatrixRow = {
  ticker: "NVDA",
  platform: "bstocks",
  symbol: "NVDAB",
  address: NVDAB,
  tokenPrice: 230.9,
  multiplier: MULT,
  perShare: 230.9 / MULT,
  reference: 230.6,
  referenceSource: "ondo",
  displayedGapPct: 230.9 / MULT / 230.6 - 1,
  assetStatus: null,
  holders: null,
  flags: ["STATUS_MISSING"],
};

function gateAt(ts: number, session: SessionName = "regular", quoteOverrides: Record<string, unknown> = {}): GateResult {
  const data = QuoteResponseSchema.parse(raw("usdtNvdab.quote")).map((r) => ({ ...r, quoteId: `q-${ts}`, ...quoteOverrides }));
  const quote = parseQuote({ venue: { symbol: "NVDAB", address: NVDAB, multiplier: MULT }, usd: USD, multiplier: MULT, reference: row.reference, ts }, data);
  return { ticker: "NVDA", row, session, quote, verdict: evaluateVenue({ row, quote }, { session, now: ts }, DEFAULT_POLICY) };
}

const transferLog = (token: string, from: string, to: string, value: bigint): Log =>
  ({
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: from as `0x${string}`, to: to as `0x${string}` } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  }) as unknown as Log;

const receiptFor = (hash: string, status: "success" | "reverted" = "success"): TransactionReceipt =>
  ({
    transactionHash: hash,
    status,
    blockNumber: 12_345n,
    gasUsed: 200_000n,
    effectiveGasPrice: 55_000_000n,
    logs: hash === "0xswap" ? [transferLog(USDT_BSC, W, ROUTER, AMOUNT), transferLog(NVDAB, ROUTER, W, OUT)] : [],
  }) as unknown as TransactionReceipt;

interface FakeState {
  usdt: bigint;
  bnb: bigint;
  allowance: bigint;
}

function fakeDeps(over: Partial<ExecDeps> = {}, state: FakeState = { usdt: 2n * 10n ** 18n, bnb: 4n * 10n ** 15n, allowance: 0n }) {
  let clock = NOW;
  const executed: string[] = [];
  const deps: ExecDeps = {
    gate: vi.fn(async () => gateAt(clock)),
    requote: vi.fn(async () => gateAt(clock)),
    api: {
      getApproveTx: vi.fn(async () => ApproveResponseSchema.parse(raw("approve"))[0]!),
      buildSwap: vi.fn(async () => SWAP),
      simulateTx: vi.fn(async () =>
        SimulateResponseSchema.parse({ status: "SUCCESS", failReason: "", balanceChanges: [{ contractAddress: NVDAB, tokenType: "Erc20", change: OUT.toString(), owner: W }] }),
      ),
      quoteRoute: vi.fn(async () => ({ route: QuoteResponseSchema.parse(raw("bnbUsdt.quote"))[0]!, routeCount: 2 })),
      txDetail: vi.fn(async () => ({ ok: true })),
    },
    chain: {
      balance: vi.fn(async (token: string) => (token === USDT_BSC ? state.usdt : token === NATIVE_BNB ? state.bnb : 0n)),
      allowance: vi.fn(async () => state.allowance),
      waitForReceipt: vi.fn(async (hash: string) => receiptFor(hash)),
    },
    overrideSim: vi.fn(async () => ({ ok: true, error: null, overrides: { token: USDT_BSC, balance: AMOUNT.toString(), spender: ROUTER, allowance: AMOUNT.toString() } })),
    baw: {
      preview: vi.fn(async (c) => ({ requestId: c.to === USDT_BSC ? "req-approve" : "req-swap", requireConfirmation: false, expiresAt: null, simulationOk: true, simulationError: null, risks: [], raw: {} })),
      execute: vi.fn(async (id: string) => {
        executed.push(id);
        if (id === "req-approve") state.allowance = AMOUNT;
        return { status: "BROADCASTED", txHash: id === "req-approve" ? "0xapprove" : "0xswap", raw: {} };
      }),
      findTxSince: vi.fn(async () => null),
    },
    confirm: vi.fn(async () => true),
    now: () => (clock += 1000),
    sleep: vi.fn(async () => undefined),
    log: () => undefined,
    ...over,
  };
  return { deps, executed, state };
}

const env = { GAP_WALLET_ADDRESS: W };
const run = (deps: ExecDeps, o: Partial<Parameters<typeof executeTrade>[1]> = {}) =>
  executeTrade("NVDAB", { usd: USD, env, deps, receiptsDir: null, ...o });

let tmp: string | null = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("executeTrade rails", () => {
  it("dry run is the default: gates, checks the exact approval, simulates, never touches baw", async () => {
    const { deps } = fakeDeps();
    const { receipt } = await run(deps);
    expect(receipt.outcome).toBe("SIMULATED");
    expect(receipt.mode).toBe("dry-run");
    expect(receipt.gate?.verdict).toBe("GO");
    expect(receipt.approval).toMatchObject({ needed: true, amount: AMOUNT.toString(), spender: ROUTER });
    expect(receipt.simulation).toMatchObject({ source: "binance-transaction-api", status: "SUCCESS", tokenDelta: OUT.toString() });
    expect(receipt.swap?.worstCaseGapPct).toBeLessThan(DEFAULT_POLICY.cautionMaxGapPct);
    expect(deps.baw.preview).not.toHaveBeenCalled();
    expect(deps.baw.execute).not.toHaveBeenCalled();
  });

  it("the kill switch refuses before any network call", async () => {
    const { deps } = fakeDeps();
    const { receipt } = await run(deps, { env: { ...env, GAP_EXEC_DISABLED: "1" }, live: true });
    expect(receipt).toMatchObject({ outcome: "REFUSED", refusal: { code: "EXEC_DISABLED" } });
    expect(deps.gate).not.toHaveBeenCalled();
  });

  it("refuses sizes over the per-trade cap and nonsense sizes", async () => {
    expect((await run(fakeDeps().deps, { usd: 30 })).receipt.refusal?.code).toBe("SIZE_OVER_CAP");
    expect((await run(fakeDeps().deps, { usd: -1 })).receipt.refusal?.code).toBe("BAD_SIZE");
  });

  it("refuses anything that is not GO (off-hours caps the verdict at CAUTION)", async () => {
    const { deps } = fakeDeps({ gate: vi.fn(async () => gateAt(NOW, "postmarket")) });
    const { receipt } = await run(deps, { live: true });
    expect(receipt.refusal?.code).toBe("GATE_NOT_GO");
    expect(receipt.refusal?.message).toMatch(/CAUTION/);
    expect(receipt.gate?.verdict).toBe("CAUTION");
    expect(deps.chain.balance).not.toHaveBeenCalled();
  });

  it("refuses a GO verdict whose quote has aged past the policy limit", async () => {
    // Gated GO at quote time, but execution happens 2 minutes later.
    const { deps } = fakeDeps({ gate: vi.fn(async () => gateAt(NOW - 120_000)) });
    const { receipt } = await run(deps);
    expect(receipt.refusal?.code).toBe("QUOTE_STALE");
  });

  it("refuses RFQ routes instead of signing untested typed data", async () => {
    const { deps } = fakeDeps({ gate: vi.fn(async () => gateAt(NOW + 1000, "regular", { executionMode: "RFQ" })) });
    expect((await run(deps)).receipt.refusal?.code).toBe("MODE_RFQ_UNSUPPORTED");
  });

  it("enforces the daily cap from today's live receipts", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gap-"));
    const prior = { kind: "trade", mode: "live", outcome: "FILLED", createdAt: new Date(NOW).toISOString(), usd: 4, fill: { usdSpent: 4 }, id: "prior" } as ExecReceipt;
    writeReceipt(tmp, prior);
    const { deps } = fakeDeps();
    const { receipt, path } = await run(deps, { live: true, receiptsDir: tmp });
    expect(receipt.refusal?.code).toBe("DAILY_CAP");
    expect(path && readdirSync(tmp)).toHaveLength(2);
  });

  it("refuses an unlimited approval", async () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, MAX_UINT256] });
    const { deps } = fakeDeps();
    deps.api.getApproveTx = vi.fn(async () => ({ data, dexContractAddress: ROUTER, gasLimit: "70000", gasPrice: "55000000" }));
    expect((await run(deps)).receipt.refusal?.code).toBe("APPROVE_NOT_EXACT");
  });

  it("refuses an approval to a spender other than the quoted router", async () => {
    const other = "0x2222222222222222222222222222222222222222";
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [other, AMOUNT] });
    const { deps } = fakeDeps();
    deps.api.getApproveTx = vi.fn(async () => ({ data, dexContractAddress: other, gasLimit: "70000", gasPrice: "55000000" }));
    expect((await run(deps)).receipt.refusal?.code).toBe("APPROVE_SPENDER_MISMATCH");
  });

  it("skips the approval when the allowance already covers the trade", async () => {
    const { deps } = fakeDeps({}, { usdt: 2n * 10n ** 18n, bnb: 4n * 10n ** 15n, allowance: AMOUNT });
    const { receipt } = await run(deps);
    expect(receipt.approval?.needed).toBe(false);
    expect(deps.api.getApproveTx).not.toHaveBeenCalled();
  });

  it("refuses swap calldata from another wallet, to another contract, or carrying BNB", async () => {
    const other = "0x2222222222222222222222222222222222222222";
    for (const [patch, code] of [
      [{ from: other }, "TX_FROM_MISMATCH"],
      [{ to: other }, "TX_TARGET_MISMATCH"],
      [{ value: "1" }, "TX_VALUE_MISMATCH"],
    ] as const) {
      const { deps } = fakeDeps();
      deps.api.buildSwap = vi.fn(async () => ({ ...SWAP, tx: { ...SWAP.tx!, ...patch } }));
      expect((await run(deps)).receipt.refusal?.code).toBe(code);
    }
  });

  it("refuses when /swap turns out to be an RFQ route", async () => {
    const { deps } = fakeDeps();
    deps.api.buildSwap = vi.fn(async () => ({ ...SWAP, executionMode: "RFQ", tx: null }));
    expect((await run(deps)).receipt.refusal?.code).toBe("MODE_RFQ_UNSUPPORTED");
  });

  it("refuses a funded wallet whose simulation reverts, without signing", async () => {
    const { deps } = fakeDeps({}, { usdt: 2n * 10n ** 18n, bnb: 4n * 10n ** 15n, allowance: AMOUNT });
    deps.api.simulateTx = vi.fn(async () => SimulateResponseSchema.parse(raw("usdtNvdab.simulate")));
    const { receipt } = await run(deps, { live: true });
    expect(receipt).toMatchObject({ outcome: "REFUSED", refusal: { code: "SIMULATION_FAILED" } });
    expect(deps.baw.execute).not.toHaveBeenCalled();
  });

  it("dry run on an unfunded wallet proves the fill with a state-override eth_call", async () => {
    const { deps } = fakeDeps({}, { usdt: 0n, bnb: 4n * 10n ** 15n, allowance: 0n });
    deps.api.simulateTx = vi.fn(async () => SimulateResponseSchema.parse(raw("usdtNvdab.simulate")));
    const { receipt } = await run(deps);
    expect(receipt.outcome).toBe("SIMULATED");
    expect(receipt.simulation).toMatchObject({ source: "eth_call-state-override", status: "SUCCESS", apiStatus: "FAILED" });
    expect(deps.overrideSim).toHaveBeenCalledWith(expect.objectContaining({ from: W, to: ROUTER }), { token: USDT_BSC, balance: AMOUNT, spender: ROUTER, allowance: AMOUNT });
  });

  it("live refuses an unfunded wallet up front", async () => {
    const { deps } = fakeDeps({}, { usdt: 10n ** 17n, bnb: 4n * 10n ** 15n, allowance: 0n });
    expect((await run(deps, { live: true })).receipt.refusal?.code).toBe("INSUFFICIENT_BALANCE");
  });
});

describe("executeTrade live path", () => {
  it("approves the exact amount, re-quotes, swaps, and records the realized fill", async () => {
    const { deps, executed } = fakeDeps();
    const { receipt } = await run(deps, { live: true });
    expect(receipt.outcome).toBe("FILLED");
    expect(executed).toEqual(["req-approve", "req-swap"]);
    expect(deps.confirm).toHaveBeenCalledTimes(2);
    expect(deps.requote).toHaveBeenCalledTimes(1);
    expect(receipt.approval).toMatchObject({ txHash: "0xapprove", bscscan: "https://bscscan.com/tx/0xapprove" });
    expect(receipt.swap).toMatchObject({ txHash: "0xswap", broadcastStatus: "BROADCASTED", blockNumber: "12345", gasUsed: "200000" });
    expect(receipt.swap?.gasCostBnb).toBeCloseTo(0.000011, 9);
    expect(receipt.fill?.usdSpent).toBe(1.5);
    expect(receipt.fill?.tokensOut).toBeCloseTo(Number(OUT) / 1e18, 12);
    expect(receipt.fill?.realizedVsQuotedPct).toBeCloseTo(0, 9);
    expect(receipt.txDetail).toEqual({ ok: true });
  });

  it("stops at the wallet preview when its risk scan flags anything", async () => {
    const { deps } = fakeDeps({}, { usdt: 2n * 10n ** 18n, bnb: 4n * 10n ** 15n, allowance: AMOUNT });
    deps.baw.preview = vi.fn(async () => ({ requestId: "r", requireConfirmation: false, expiresAt: null, simulationOk: true, simulationError: null, risks: [{ level: "HIGH" }], raw: {} }));
    const { receipt } = await run(deps, { live: true });
    expect(receipt.refusal?.code).toBe("PREVIEW_REJECTED");
    expect(deps.baw.execute).not.toHaveBeenCalled();
  });

  it("declining the confirmation broadcasts nothing", async () => {
    const { deps } = fakeDeps({ confirm: vi.fn(async () => false) }, { usdt: 2n * 10n ** 18n, bnb: 4n * 10n ** 15n, allowance: AMOUNT });
    const { receipt } = await run(deps, { live: true });
    expect(receipt).toMatchObject({ outcome: "REFUSED", refusal: { code: "USER_DECLINED" } });
    expect(deps.baw.execute).not.toHaveBeenCalled();
  });

  it("waits for an in-app confirmation and finds the hash in history", async () => {
    const { deps } = fakeDeps({}, { usdt: 2n * 10n ** 18n, bnb: 4n * 10n ** 15n, allowance: AMOUNT });
    deps.baw.execute = vi.fn(async () => ({ status: "PENDING_CONFIRMATION", txHash: null, raw: {} }));
    deps.baw.findTxSince = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("0xswap");
    const { receipt } = await run(deps, { live: true });
    expect(receipt.outcome).toBe("FILLED");
    expect(receipt.swap).toMatchObject({ broadcastStatus: "PENDING_CONFIRMATION", txHash: "0xswap" });
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("an on-chain revert is FAILED with the hash kept", async () => {
    const { deps } = fakeDeps({}, { usdt: 2n * 10n ** 18n, bnb: 4n * 10n ** 15n, allowance: AMOUNT });
    deps.chain.waitForReceipt = vi.fn(async (h: string) => receiptFor(h, "reverted"));
    const { receipt } = await run(deps, { live: true });
    expect(receipt).toMatchObject({ outcome: "FAILED", refusal: { code: "TX_REVERTED" }, swap: { txHash: "0xswap" } });
  });

  it("writes one receipt per run and counts live fills toward today's spend", async () => {
    tmp = mkdtempSync(join(tmpdir(), "gap-"));
    const { deps } = fakeDeps();
    const { path } = await run(deps, { live: true, receiptsDir: tmp });
    expect(path).toMatch(/exec-NVDAB\.json$/);
    const all = listReceipts(tmp);
    expect(all).toHaveLength(1);
    expect(spentTodayUsd(all, NOW)).toBe(1.5);
    expect(spentTodayUsd(all, NOW + 86_400_000)).toBe(0);
  });
});

describe("fundUsdt", () => {
  const BNB_SIM = () => SimulateResponseSchema.parse(raw("bnbUsdt.simulate"));
  const fundDeps = () => {
    const f = fakeDeps({}, { usdt: 0n, bnb: 4_519_200_000_000_000n, allowance: 0n });
    f.deps.api.buildSwap = vi.fn(async () => SwapResponseSchema.parse(raw("bnbUsdt.swap")));
    f.deps.api.simulateTx = vi.fn(async () => BNB_SIM());
    f.deps.chain.waitForReceipt = vi.fn(async (hash: string) => ({ ...receiptFor(hash), logs: [transferLog(USDT_BSC, ROUTER, W, 2_500_000_000_000_000_000n)] }) as unknown as TransactionReceipt);
    return f;
  };

  it("dry run quotes, checks the tx value, and simulates the conversion", async () => {
    const { deps } = fundDeps();
    const { receipt } = await fundUsdt({ bnb: 0.0033, env, deps, receiptsDir: null });
    expect(receipt).toMatchObject({ kind: "funding", outcome: "SIMULATED", simulation: { status: "SUCCESS" } });
    expect(receipt.usd).toBeGreaterThan(2);
    expect(deps.baw.preview).not.toHaveBeenCalled();
  });

  it("keeps a BNB gas reserve", async () => {
    const { deps } = fundDeps();
    const { receipt } = await fundUsdt({ bnb: 0.004, env, deps, receiptsDir: null });
    expect(receipt.refusal?.code).toBe("INSUFFICIENT_GAS");
  });

  it("live signs through the wallet and records USDT received", async () => {
    const { deps } = fundDeps();
    const { receipt } = await fundUsdt({ bnb: 0.0033, live: true, env, deps, receiptsDir: null });
    expect(receipt.outcome).toBe("FILLED");
    expect(receipt.fill?.tokensOut).toBe(2.5);
    expect(receipt.swap?.txHash).toBe("0xswap");
    expect(receipt.id).toMatch(/fund-BNBUSDT$/);
  });
});
