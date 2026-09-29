import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { MAX_UINT256, USDT_SLOTS, decodeApprove, mappingSlot, nestedMappingSlot, transferSum } from "../src/chain";

const trade = JSON.parse(readFileSync(resolve(__dirname, "fixtures/trade.json"), "utf8"));
const ROUTER = "0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const W = "0x1111111111111111111111111111111111111111";

const transferLog = (token: string, from: string, to: string, value: bigint): Log =>
  ({
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: from as `0x${string}`, to: to as `0x${string}` } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  }) as unknown as Log;

describe("chain helpers", () => {
  it("decodes the recorded approve calldata as an exact 1.5 USDT approval to the router", () => {
    const d = decodeApprove(trade.calls.approve.data[0].data);
    expect(d).toEqual({ spender: ROUTER, amount: 1_500_000_000_000_000_000n });
    expect(d!.amount).not.toBe(MAX_UINT256);
  });

  it("returns null for calldata that is not approve()", () => {
    expect(decodeApprove(trade.calls["usdtNvdab.swap"].data.tx.data)).toBeNull();
    expect(decodeApprove("0x")).toBeNull();
  });

  it("sums Transfer logs per token and direction", () => {
    const logs = [
      transferLog(USDT, W, ROUTER, 1_500_000_000_000_000_000n),
      transferLog(NVDAB, ROUTER, W, 6_000_000_000_000_000n),
      transferLog(NVDAB, ROUTER, W, 500_000_000_000_000n),
      transferLog(NVDAB, ROUTER, "0x2222222222222222222222222222222222222222", 9n),
    ];
    expect(transferSum(logs, NVDAB, W, "to")).toBe(6_500_000_000_000_000n);
    expect(transferSum(logs, USDT, W, "from")).toBe(1_500_000_000_000_000_000n);
    expect(transferSum(logs, USDT, W, "to")).toBe(0n);
  });

  it("pins the BSC-USD storage slots verified live against balanceOf", () => {
    expect(USDT_SLOTS).toEqual({ balances: 1n, allowances: 2n });
    // balanceOf(0x8894...D4E3) equalled eth_getStorageAt at this slot on 2026-09-29.
    expect(mappingSlot("0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", 1n)).toBe("0x2a1e20cfdc0a1a03b0a1a44fdd9fd5fa930358e5b8221476467d529192e1b4b4");
    expect(nestedMappingSlot(W, ROUTER, 2n)).toBe("0x0dc2d93c5e1a04df3c06cb52c49523e064d332a8c5a9be5dbf1fa75fd21e92d6");
  });
});
