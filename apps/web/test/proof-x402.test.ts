import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listX402Receipts } from "@gapdesk/core";
import { buildX402Ledger, identityRow, selftestRow, type B402SelftestRecord, type IdentityRecord, type OnchainAnnotations, type SaleRecord } from "../lib/proof";

const root = resolve(import.meta.dirname, "../../..");
const json = <T>(...p: string[]): T => JSON.parse(readFileSync(resolve(root, ...p), "utf8")) as T;
const jsonDir = <T>(...p: string[]): T[] =>
  readdirSync(resolve(root, ...p))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => json<T>(...p, f));

describe("x402 proof ledger", () => {
  const receipts = listX402Receipts(resolve(root, "receipts/x402"));
  const sales = jsonDir<SaleRecord>("receipts/x402-sales");
  const onchain = json<OnchainAnnotations>("receipts/x402-onchain.json");
  const ledger = buildX402Ledger(receipts, sales, onchain);

  it("lists the paid sale once, with its B402 settlement", () => {
    expect(ledger.sales).toHaveLength(1);
    const sale = ledger.sales[0]!;
    expect(sale).toMatchObject({
      endpoint: "https://executable-gap-desk.vercel.app/x402/gap/NVDA",
      priceU: "0.01",
      independent: false,
      httpStatus: 200,
      block: "124768659",
      submittedBy: "0x34f7a661160780ce1346e6d7b96d2be244590899",
    });
    expect(sale.tx.url).toBe(`https://bscscan.com/tx/${sale.tx.hash}`);
    expect(sale.tx.hash.startsWith("0x24e93e2b")).toBe(true);
    expect(ledger.purchases.some((p) => p.seller === "executable-gap-desk.vercel.app")).toBe(false);
  });

  it("lists purchases from other sellers: four rejected Stock Agent jobs and the CoinMarketCap call", () => {
    const stock = ledger.purchases.filter((p) => p.seller === "stock-agent.bnbchain.org");
    expect(stock).toHaveLength(4);
    expect(stock.every((p) => p.outcome === "FAILED" && p.tx === null && p.amount === "0.1" && p.token === "U")).toBe(true);
    expect(stock.every((p) => p.error === "payment_rejected")).toBe(true);

    const cmc = ledger.purchases.filter((p) => p.seller === "mcp.coinmarketcap.com");
    expect(cmc).toHaveLength(1);
    expect(cmc[0]).toMatchObject({ outcome: "PAID", amount: "0.01", httpStatus: 200, txFoundOnchain: true });
    expect(cmc[0]?.tx?.hash.startsWith("0xf3972ad5")).toBe(true);

    const times = ledger.purchases.map((p) => p.createdAt);
    expect(times).toEqual([...times].sort());
  });

  it("counts dry runs separately", () => {
    expect(ledger.dryRuns).toBe(receipts.filter((r) => r.mode !== "live").length);
    expect(ledger.dryRuns).toBeGreaterThanOrEqual(3);
  });

  it("copies only display fields, never proofs or job credentials", () => {
    const text = JSON.stringify(ledger);
    for (const banned of ["jobToken", "jobId", "signature", "authorization", "paymentId", "validBefore"]) expect(text).not.toContain(banned);
  });
});

describe("identity and B402 self-test rows", () => {
  it("shows ERC-8004 agent 360456 with its registration tx", () => {
    const row = identityRow(json<IdentityRecord>("receipts/identity.json"));
    expect(row).toMatchObject({
      agentId: "360456",
      agentURI: "https://executable-gap-desk.vercel.app/.well-known/agent-card.json",
      agentRegistry: "eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      block: "124764688",
    });
    expect(row?.tx.hash.startsWith("0xd8b607b0")).toBe(true);
    expect(identityRow(null)).toBeNull();
  });

  it("shows the live verify-only self-test and skips dry runs", () => {
    const records = jsonDir<B402SelftestRecord>("receipts/b402");
    const live = records.filter((r) => r.mode === "live").at(-1) ?? null;
    expect(selftestRow(live)).toMatchObject({ isValid: true, amount: "0.01", token: "U", payTo: "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65" });
    const dry = records.find((r) => r.mode !== "live");
    if (dry) expect(selftestRow(dry)).toBeNull();
  });
});
