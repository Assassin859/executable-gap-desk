import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createBawWallet,
  limitBuyArgs,
  marketQuoteArgs,
  marketSwapArgs,
  toOrderInfo,
  walletBalanceArgs,
  type BawRunner,
} from "../src";

const rec = JSON.parse(readFileSync(new URL("./fixtures/baw-wallet.json", import.meta.url), "utf8")) as Record<string, string>;
const runner = (stdout: string, code = 0) => vi.fn<BawRunner>(async () => ({ code, stdout, stderr: "" }));

const AAPLB = "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

describe("baw wallet wrappers", () => {
  it("parses the recorded balance and passes --binanceChainId 56 --json", async () => {
    const run = runner(rec.balance!);
    const tokens = await createBawWallet(run).balance();
    expect(run).toHaveBeenCalledWith([...walletBalanceArgs(), "--json"]);
    expect(walletBalanceArgs()).toEqual(["wallet", "balance", "--binanceChainId", "56"]);
    const aapl = tokens.find((t) => t.symbol === "AAPLB")!;
    expect(aapl.balance).toBe("0.002859609639909174");
    expect(aapl.price).toBeCloseTo(331.34);
    expect(tokens).toHaveLength(4);
  });

  it("parses left-quota and an empty order page", async () => {
    expect(await createBawWallet(runner(rec.quota!)).quota()).toMatchObject({ quotaLeft: 50000, dailyLimit: 50000 });
    expect(await createBawWallet(runner(rec.limitListEmpty!)).limitOrders()).toEqual([]);
    expect(await createBawWallet(runner(rec.marketListEmpty!)).order("123")).toBeNull();
  });

  it("parses the recorded market quote with decimal strings intact", async () => {
    const q = await createBawWallet(runner(rec.quoteAaplbUsdt!)).quote({ fromToken: AAPLB, toToken: USDT, qty: "0.002859609639909174" });
    expect(q.toCoinAmount).toBe("0.947461127952585067");
    expect(q.fromCoinAmount).toBe("0.002859609639909174");
  });

  it("builds argv with exact quantities and rejects floats in exponent form", () => {
    expect(marketQuoteArgs({ fromToken: AAPLB, toToken: USDT, qty: "0.002859609639909174" })).toContain("0.002859609639909174");
    expect(() => marketQuoteArgs({ fromToken: AAPLB, toToken: USDT, qty: "2.8e-3" })).toThrow(/Invalid token quantity/);
    expect(() => marketQuoteArgs({ fromToken: AAPLB, toToken: USDT, qty: "0" })).toThrow(/Invalid token quantity/);
    const swap = marketSwapArgs({ fromToken: AAPLB, toToken: USDT, qty: "0.001" });
    expect(swap.slice(0, 2)).toEqual(["market-order", "swap"]);
    expect(swap).toEqual(expect.arrayContaining(["--slippage", "auto", "--mev", "true"]));
    expect(limitBuyArgs({ triggerPriceUsd: 248.125, fromToken: USDT, toToken: AAPLB, qty: "1" })).toEqual(
      expect.arrayContaining(["limit-order", "buy", "--triggerPrice", "248.125"]),
    );
  });

  it("reads order ids, statuses and tx hashes across response aliases", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(toOrderInfo({ orderId: 991, status: "finished", txHash: hash })).toMatchObject({ id: "991", status: "FINISHED", txHash: hash });
    expect(toOrderInfo({ strategyId: "s-1", orderStatus: "WORKING" })).toMatchObject({ id: "s-1", status: "WORKING", txHash: null });
    expect(toOrderInfo({ id: 5, status: "weird" }).status).toBe("UNKNOWN");
  });

  it("swap without an order id is an error, and baw failures surface", async () => {
    await expect(createBawWallet(runner('{"success":true,"data":{}}')).swap({ fromToken: AAPLB, toToken: USDT, qty: "0.001" })).rejects.toThrow(/no order id/);
    await expect(createBawWallet(runner('{"success":false,"message":"insufficient balance"}', 1)).balance()).rejects.toThrow(/insufficient/);
  });

  it("cancel validates the strategy id before running baw", async () => {
    const run = runner('{"success":true,"data":true}');
    await expect(createBawWallet(run).limitCancel("1; rm -rf")).rejects.toThrow(/Invalid strategy id/);
    expect(run).not.toHaveBeenCalled();
    await createBawWallet(run).limitCancel("12345");
    expect(run).toHaveBeenCalledWith(["limit-order", "cancel", "--strategyId", "12345", "--json"]);
  });
});
