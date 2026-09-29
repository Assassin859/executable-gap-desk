import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { USDT_BSC } from "../src/config";
import { ApproveResponseSchema, SimulateResponseSchema, SwapResponseSchema } from "../src/schemas";
import { NATIVE_BNB, approvePath, rawQuotePath, simulateBody, simulatedChange, swapPath } from "../src/trade";

type Call = { ok: boolean; data: unknown };
const trade = JSON.parse(readFileSync(resolve(__dirname, "fixtures/trade.json"), "utf8")) as { wallet: string; calls: Record<string, Call> };
const data = (k: string) => trade.calls[k]!.data;
const W = trade.wallet;

describe("trade API schemas (recorded responses)", () => {
  it("parses the exact USDT approval with the router as spender", () => {
    const [a] = ApproveResponseSchema.parse(data("approve"));
    expect(a!.dexContractAddress).toBe("0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5");
    expect(a!.data.startsWith("0x095ea7b3")).toBe(true);
    expect(a!.gasLimit).toBe("70000");
  });

  it("parses /swap into an unsigned tx sent from the wallet to the router", () => {
    const s = SwapResponseSchema.parse(data("usdtNvdab.swap"));
    expect(s.executionMode).toBe("SWAP");
    expect(s.tx!.from.toLowerCase()).toBe(W);
    expect(s.tx!.to).toBe("0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5");
    expect(s.tx!.value).toBe("0");
    expect(BigInt(s.tx!.minReceiveAmount!)).toBeLessThan(BigInt(s.routerResult!.toTokenAmount!));
    expect(s.tx!.slippagePercent).toBe(0.5);
  });

  it("native BNB swaps carry the sell amount as tx value", () => {
    const s = SwapResponseSchema.parse(data("bnbUsdt.swap"));
    expect(s.tx!.value).toBe("3300000000000000");
  });

  it("a revert is status FAILED with a reason, not an API error", () => {
    const sim = SimulateResponseSchema.parse(data("usdtNvdab.simulate"));
    expect(sim.status).toBe("FAILED");
    expect(sim.failReason).toMatch(/exceeds balance/);
    expect(sim.balanceChanges).toEqual([]);
  });

  it("reads per-token balance changes from a successful simulation", () => {
    const sim = SimulateResponseSchema.parse(data("bnbUsdt.simulate"));
    expect(sim.status).toBe("SUCCESS");
    expect(simulatedChange(sim, W, USDT_BSC)).toBeGreaterThan(0n);
    expect(simulatedChange(sim, W, NATIVE_BNB)).toBe(-3300000000000000n);
    expect(simulatedChange(sim, "0x0000000000000000000000000000000000000001", USDT_BSC)).toBe(0n);
  });
});

describe("trade API request builders", () => {
  const route = { fromToken: USDT_BSC, toToken: "0xabc", amount: "1500000000000000000", wallet: W };

  it("builds quote, swap and approve query strings with exact base-unit amounts", () => {
    expect(rawQuotePath(route)).toBe(
      `/api/v1/dex/aggregator/quote?binanceChainId=56&fromTokenAddress=${USDT_BSC}&toTokenAddress=0xabc&amount=1500000000000000000&userWalletAddress=${W}`,
    );
    expect(swapPath({ ...route, quoteId: "q1", slippagePct: 0.5 })).toMatch(/&quoteId=q1&slippagePercent=0\.5$/);
    expect(approvePath(USDT_BSC, "1500000000000000000")).toBe(
      `/api/v1/dex/aggregator/approve-transaction?binanceChainId=56&tokenContractAddress=${USDT_BSC}&approveAmount=1500000000000000000`,
    );
  });

  it("omits empty gas fields from the simulate body", () => {
    expect(simulateBody({ from: "0xa", to: "0xb", data: "0x", value: "0", gasLimit: null })).toEqual({
      binanceChainId: "56",
      evmTx: { from: "0xa", to: "0xb", data: "0x", value: "0" },
    });
  });
});
