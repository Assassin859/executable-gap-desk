import { describe, expect, it, vi } from "vitest";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  LocalPaymentError,
  U_BSC,
  buildRequirements,
  createNonceGuard,
  decodePaymentPayload,
  eip3009TypedData,
  encodePaymentSignature,
  priceToAmount,
  sellX402,
  signEip3009Payment,
  type B402Client,
  type B402Kind,
  type SellDeps,
} from "../src/index";
import { fixture } from "./helpers";

const W = "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65";
const NOW = Date.parse("2026-09-29T20:00:00Z");
const NONCE = `0x${"ab".repeat(32)}` as Hex;
// Anvil's well-known test key #0; never funded on BSC.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const rec = fixture<{ response: { data: { kinds: B402Kind[] } } }>("b402-supported.json");
const reqs = () => buildRequirements(structuredClone(rec.response.data.kinds), { amount: priceToAmount("0.01"), payTo: W });
const CAP = priceToAmount("0.02");

describe("local EIP-3009 buyer", () => {
  it("builds the token's own TransferWithAuthorization domain from the requirement", () => {
    const u = reqs()[0]!;
    expect(u.asset).toBe(U_BSC);
    const td = eip3009TypedData(u, { from: account.address, to: W, value: u.amount, validAfter: "1", validBefore: "2", nonce: NONCE });
    expect(td.domain).toEqual({ name: "United Stables", version: u.extra!.version, chainId: 56, verifyingContract: U_BSC });
    expect(td.primaryType).toBe("TransferWithAuthorization");
    expect(td.types.TransferWithAuthorization.map((f) => f.name)).toEqual(["from", "to", "value", "validAfter", "validBefore", "nonce"]);
  });

  it("signs a payload our seller accepts: accepted is unchanged, the signer recovers, the window is open", async () => {
    const u = reqs()[0]!;
    const p = await signEip3009Payment(u, { account, now: NOW, nonce: NONCE, maxAmount: BigInt(CAP), expectPayTo: W, resourceUrl: "https://executable-gap-desk.vercel.app/x402/gap/NVDA" });
    expect(p.accepted).toEqual(u);
    const a = p.payload.authorization as { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };
    expect(a).toMatchObject({ from: account.address, to: W, value: u.amount, nonce: NONCE });
    expect(Number(a.validAfter)).toBeLessThan(NOW / 1000);
    expect(Number(a.validBefore)).toBe(NOW / 1000 + (u.maxTimeoutSeconds ?? 300));
    const td = eip3009TypedData(u, a);
    expect(await recoverTypedDataAddress({ ...td, signature: p.payload.signature as Hex })).toBe(account.address);
    expect(hashTypedData(td)).toMatch(/^0x[0-9a-f]{64}$/);

    const header = encodePaymentSignature(p);
    expect(decodePaymentPayload(header)).toEqual(p);

    const client: B402Client = {
      supported: vi.fn(),
      verify: vi.fn(async () => ({ isValid: true, payer: account.address })),
      settle: vi.fn(async () => ({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:56", payer: account.address })),
    };
    const d: SellDeps = { client, payTo: W, kinds: async () => structuredClone(rec.response.data.kinds), guard: createNonceGuard(() => NOW), now: () => NOW };
    const r = await sellX402(
      { priceU: "0.01", resource: { url: "https://executable-gap-desk.vercel.app/x402/gap/NVDA", description: "gate", mimeType: "application/json" }, proof: header, work: async () => ({ ok: true }) },
      d,
    );
    expect(r.status).toBe(200);
    expect(vi.mocked(client.verify).mock.calls[0]![1]).toEqual(u);
  });

  it("refuses to sign over the cap, to the wrong payee, or a permit2 requirement", async () => {
    const u = reqs()[0]!;
    await expect(signEip3009Payment(u, { account, maxAmount: BigInt(u.amount) - 1n })).rejects.toThrow(LocalPaymentError);
    await expect(signEip3009Payment(u, { account, maxAmount: BigInt(CAP), expectPayTo: "0x0000000000000000000000000000000000000001" })).rejects.toThrow(/not the expected/);
    await expect(signEip3009Payment({ ...u, extra: { ...u.extra, assetTransferMethod: "permit2-exact" } }, { account, maxAmount: BigInt(CAP) })).rejects.toThrow(/Only exact\/eip3009/);
  });
});
