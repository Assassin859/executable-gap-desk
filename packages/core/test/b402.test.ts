import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  B402_TOKENS,
  USD1_BSC,
  U_BSC,
  b402Config,
  b402CredentialsFromEnv,
  b402Ready,
  b402Selftest,
  buildRequirements,
  cachedKinds,
  createB402Client,
  createNonceGuard,
  decodePaymentPayload,
  decodePaymentRequired,
  decodePaymentResponse,
  describeB402Error,
  priceToAmount,
  sellX402,
  unwrapEnvelope,
  type B402Client,
  type B402Kind,
  type PaymentRequirement,
  type SellDeps,
  type X402Preview,
} from "../src/index";
import { fixture } from "./helpers";

const W = "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65";
const BUYER = "0x1111111111111111111111111111111111111111";
const NOW = Date.parse("2026-09-29T20:00:00Z");
const TX = `0x${"cd".repeat(32)}`;
const rec = fixture<{ response: { code: string; data: { kinds: B402Kind[] } } }>("b402-supported.json");
const kinds = () => structuredClone(rec.response.data.kinds);
const creds = { apiKey: "test-key", apiSecret: "test-secret" };

afterEach(() => vi.unstubAllGlobals());

describe("B402 client", () => {
  it("posts the signed {body} envelope to /build/api/v2/b402/* and unwraps the nine-zero code", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rec.response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const s = await createB402Client(creds).supported();
    expect(s.kinds).toHaveLength(10);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://web3.binance.com/build/api/v2/b402/supported");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"body":{}}');
    const ts = init.headers["X-OC-TIMESTAMP"]!;
    const want = createHmac("sha256", "test-secret").update(`${ts}POST/build/api/v2/b402/supported{"body":{}}`).digest("base64");
    expect(init.headers["X-OC-SIGN"]).toBe(want);
    expect(init.headers["X-OC-APIKEY"]).toBe("test-key");
  });

  it("wraps verify and settle bodies with x402Version 2 and parses their data", async () => {
    const post = vi.fn(async (path: string) => (path.endsWith("verify") ? { isValid: false, invalidReason: "invalid_exact_evm_payload_recipient_mismatch" } : { success: true, transaction: TX, network: "eip155:56", payer: BUYER }));
    const c = createB402Client(creds, post);
    const req = { scheme: "exact", network: "eip155:56", amount: "1", asset: U_BSC, payTo: W };
    await expect(c.verify({ p: 1 }, req)).resolves.toMatchObject({ isValid: false, invalidReason: "invalid_exact_evm_payload_recipient_mismatch" });
    await expect(c.settle({ p: 1 }, req)).resolves.toMatchObject({ success: true, transaction: TX });
    expect(post).toHaveBeenNthCalledWith(1, "/api/v2/b402/verify", { x402Version: 2, paymentPayload: { p: 1 }, paymentRequirements: req });
  });

  it("maps envelope codes to readable errors", () => {
    expect(unwrapEnvelope("/x", 200, { code: "000000000", data: 1 })).toBe(1);
    expect(unwrapEnvelope("/x", 200, { code: "000000", data: 2 })).toBe(2);
    expect(() => unwrapEnvelope("/x", 200, { code: "000000001", data: null })).toThrow(ApiError);
    let err: unknown;
    try {
      unwrapEnvelope("/api/v2/b402/supported", 200, { status: "ERROR", code: "1160401", errorData: null, data: null, message: "merchant not found" });
    } catch (e) {
      err = e;
    }
    expect(describeB402Error(err)).toMatch(/1160401 \(merchant not found; complete B402 onboarding/);
    expect(describeB402Error(new ApiError({ endpoint: "/v", httpStatus: 200, code: "1160409", msg: "budget" }))).toMatch(/gas-sponsored settlement budget/);
  });
});

describe("B402 config and requirements", () => {
  it("prefers a dedicated B402 key, falls back to the BW3 pair, and payTo falls back to the wallet", () => {
    expect(b402CredentialsFromEnv({ BW3_API_KEY: "a", BW3_API_SECRET: "b" } as NodeJS.ProcessEnv)).toEqual({ apiKey: "a", apiSecret: "b" });
    expect(b402CredentialsFromEnv({ BW3_API_KEY: "a", BW3_API_SECRET: "b", B402_API_KEY: "c", B402_API_SECRET: "d" } as NodeJS.ProcessEnv)).toEqual({ apiKey: "c", apiSecret: "d" });
    expect(b402Config({ BW3_API_KEY: "a", BW3_API_SECRET: "b", GAP_WALLET_ADDRESS: W } as NodeJS.ProcessEnv)).toMatchObject({ payTo: W, missing: [] });
    expect(b402Config({ B402_PAY_TO: "nope" } as NodeJS.ProcessEnv).missing).toHaveLength(2);
  });

  it("builds exact EIP-3009 requirements, U first then USD1, with extra copied verbatim", () => {
    const ks = kinds();
    const reqs = buildRequirements(ks, { amount: priceToAmount("0.01"), payTo: W });
    expect(reqs.map((r) => r.asset)).toEqual([U_BSC, USD1_BSC]);
    const uKind = ks.find((k) => k.extra?.name === "United Stables" && k.extra?.assetTransferMethod === "eip3009")!;
    expect(reqs[0]).toEqual({ scheme: "exact", network: "eip155:56", amount: "10000000000000000", asset: U_BSC, payTo: W, maxTimeoutSeconds: 300, extra: uKind.extra });
    expect(reqs.every((r) => (r.extra as Record<string, unknown>).assetTransferMethod === "eip3009")).toBe(true);
    const noU = ks.filter((k) => k.extra?.name !== "United Stables");
    expect(buildRequirements(noU, { amount: "1", payTo: W }).map((r) => r.asset)).toEqual([USD1_BSC]);
  });

  it("reports readiness from /supported", async () => {
    const ready = await b402Ready({ supported: async () => ({ kinds: kinds(), signers: { "eip155:*": ["0x34F7a661160780Ce1346e6D7B96D2bE244590899"] } }) });
    expect(ready).toMatchObject({ kinds: 10, sellable: ["U", "USD1"], signers: ["0x34F7a661160780Ce1346e6D7B96D2bE244590899"] });
    expect(ready.offers).toContain("Tether USD exact/permit2-exact (eip155:56, v2)");
    expect(B402_TOKENS.map((t) => t.symbol)).toEqual(["U", "USD1"]);
  });

  it("caches /supported for the TTL and serves the last good copy when a refresh fails", async () => {
    let t = 0;
    const supported = vi.fn().mockResolvedValueOnce({ kinds: kinds() }).mockRejectedValueOnce(new Error("down"));
    const get = cachedKinds({ supported }, 1000, () => t);
    expect(await get()).toHaveLength(10);
    t = 500;
    await get();
    expect(supported).toHaveBeenCalledTimes(1);
    t = 1500;
    expect(await get()).toHaveLength(10);
    expect(supported).toHaveBeenCalledTimes(2);
  });
});

// ---------- the seller ----------

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const reqsFor = () => buildRequirements(kinds(), { amount: priceToAmount("0.01"), payTo: W });
const NONCE = `0x${"22".repeat(32)}`;

function proof(accepted: PaymentRequirement, over: Record<string, unknown> = {}) {
  return b64({
    x402Version: 2,
    resource: { url: "https://executable-gap-desk.vercel.app/x402/gap/NVDA" },
    accepted,
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: { from: BUYER, to: W, value: accepted.amount, validAfter: String(NOW / 1000 - 5), validBefore: String(NOW / 1000 + 120), nonce: NONCE },
    },
    ...over,
  });
}

function seller(o: { verify?: Awaited<ReturnType<B402Client["verify"]>> | Error; settle?: Awaited<ReturnType<B402Client["settle"]>>; kinds?: B402Kind[] } = {}) {
  const client: B402Client = {
    supported: vi.fn(),
    verify: vi.fn(async () => {
      if (o.verify instanceof Error) throw o.verify;
      return o.verify ?? { isValid: true, payer: BUYER };
    }),
    settle: vi.fn(async () => o.settle ?? { success: true, transaction: TX, network: "eip155:56", payer: BUYER }),
  };
  const d: SellDeps = { client, payTo: W, kinds: async () => o.kinds ?? kinds(), guard: createNonceGuard(() => NOW), now: () => NOW };
  return d;
}

const opts = (p: string | null, work: () => Promise<unknown> = vi.fn(async () => ({ gate: "GO" }))) => ({
  priceU: "0.01",
  resource: { url: "https://executable-gap-desk.vercel.app/x402/gap/NVDA", description: "gate NVDA", mimeType: "application/json" },
  bazaar: { routeTemplate: "/x402/gap/:ticker", info: { input: { type: "http" as const, method: "GET" } }, schema: { type: "object" } },
  proof: p,
  work,
});

describe("sellX402", () => {
  it("answers an unpaid request with 402 and requirements our own buyer can decode", async () => {
    const d = seller();
    const r = await sellX402(opts(null), d);
    expect(r.status).toBe(402);
    const { required } = decodePaymentRequired(r.headers["PAYMENT-REQUIRED"]!, r.body);
    expect(required.accepts).toEqual(reqsFor());
    expect(required.resource?.url).toContain("/x402/gap/NVDA");
    expect((r.body as { paymentRequired: unknown }).paymentRequired).toMatchObject({ x402Version: 2, extensions: { bazaar: { routeTemplate: "/x402/gap/:ticker" } } });
    expect(d.client.verify).not.toHaveBeenCalled();
  });

  it("refuses a proof whose accepted differs from what we issue, before any B402 call", async () => {
    const d = seller();
    const tampered = { ...reqsFor()[0]!, amount: "1" };
    const r = await sellX402(opts(proof(tampered)), d);
    expect(r).toMatchObject({ status: 402, body: { error: "invalid_payment", reason: "invalid_payment_requirements" } });
    expect(d.client.verify).not.toHaveBeenCalled();
  });

  it("refuses junk, oversized or permit2-shaped proofs as invalid_payload", async () => {
    const d = seller();
    for (const p of ["not base64 !!", "A".repeat(9000), b64({ x402Version: 2, accepted: reqsFor()[0], payload: { signature: "0x1", permit2Authorization: {} } })]) {
      expect(await sellX402(opts(p), d)).toMatchObject({ status: 402, body: { reason: "invalid_payload" } });
    }
    expect(decodePaymentPayload(proof(reqsFor()[0]!))).not.toBeNull();
    expect(d.client.verify).not.toHaveBeenCalled();
  });

  it("passes B402's invalidReason through in the 402 and never runs the work or settles", async () => {
    const d = seller({ verify: { isValid: false, invalidReason: "insufficient_funds", invalidMessage: "balance 0" } });
    const work = vi.fn(async () => ({}));
    const r = await sellX402(opts(proof(reqsFor()[0]!), work), d);
    expect(r).toMatchObject({ status: 402, body: { error: "payment_rejected", reason: "insufficient_funds", message: "balance 0" } });
    expect(JSON.parse(Buffer.from(r.headers["PAYMENT-REQUIRED"]!, "base64").toString())).toMatchObject({ error: "insufficient_funds" });
    expect(work).not.toHaveBeenCalled();
    expect(d.client.settle).not.toHaveBeenCalled();
  });

  it("serves, settles once and returns PAYMENT-RESPONSE; a replay of the same proof is refused", async () => {
    const d = seller();
    const work = vi.fn(async () => ({ gate: "GO" }));
    const p = proof(reqsFor()[1]!);
    const r = await sellX402(opts(p, work), d);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ gate: "GO" });
    expect(decodePaymentResponse(r.headers["PAYMENT-RESPONSE"]!)).toMatchObject({ success: true, transaction: TX, payer: BUYER, network: "eip155:56" });
    expect(work).toHaveBeenCalledTimes(1);
    const [settled, requirement] = vi.mocked(d.client.settle).mock.calls[0]!;
    expect(requirement).toEqual(reqsFor()[1]);
    expect(settled).toMatchObject({ extensions: { bazaar: { routeTemplate: "/x402/gap/:ticker" } } });

    const again = await sellX402(opts(p, work), d);
    expect(again).toMatchObject({ status: 402, body: { reason: "nonce_already_used" } });
    expect(d.client.verify).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("does not charge when the work fails", async () => {
    const d = seller();
    const r = await sellX402(opts(proof(reqsFor()[0]!), vi.fn(async () => Promise.reject(new Error("quote API down")))), d);
    expect(r).toMatchObject({ status: 500, body: { error: "work_failed" } });
    expect(d.client.settle).not.toHaveBeenCalled();
  });

  it("reports a pre-broadcast settle failure as a 402 and lets the same proof retry", async () => {
    const d = seller({ settle: { success: false, transaction: "", errorReason: "invalid_exact_evm_payload_authorization_valid_before" } });
    const p = proof(reqsFor()[0]!);
    expect(await sellX402(opts(p), d)).toMatchObject({ status: 402, body: { error: "settlement_failed", reason: "invalid_exact_evm_payload_authorization_valid_before" } });
    await sellX402(opts(p), d);
    expect(d.client.verify).toHaveBeenCalledTimes(2);
  });

  it("maps B402 outages to 502 and an empty kind list to b402_unavailable", async () => {
    const down = seller({ verify: new ApiError({ endpoint: "/api/v2/b402/verify", httpStatus: 200, code: "1160102", msg: "busy" }) });
    expect(await sellX402(opts(proof(reqsFor()[0]!)), down)).toMatchObject({ status: 502, body: { error: "b402_verify_failed" } });
    expect(await sellX402(opts(null), seller({ kinds: [] }))).toMatchObject({ status: 502, body: { error: "b402_unavailable" } });
  });
});

// ---------- the self-test ----------

describe("b402Selftest", () => {
  const env = { GAP_WALLET_ADDRESS: W, BW3_API_KEY: "k", BW3_API_SECRET: "s" } as NodeJS.ProcessEnv;
  const preview = (): X402Preview => ({
    paymentId: "pay-1",
    options: [{ index: 1, status: "READY_TO_SIGN", reasons: [], tokenAddress: U_BSC, tokenSymbol: "U", amount: "0.01", amountUsd: 0.01, needApproveFirst: false, assetTransferMethod: "eip3009", originalAccept: { ...reqsFor()[0]! } }],
  });
  function deps(verify: Awaited<ReturnType<B402Client["verify"]>> = { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" }) {
    const selfReq = buildRequirements(kinds(), { amount: priceToAmount("0.01"), payTo: W })[0]!;
    const client: B402Client = { supported: vi.fn(async () => ({ kinds: kinds() })), verify: vi.fn(async () => verify), settle: vi.fn() };
    return {
      client,
      wallet: {
        x402Preview: vi.fn(async () => preview()),
        x402Sign: vi.fn(async () => ({ paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: proof(selfReq), signatureExpiresAt: NOW / 1000 + 120, approveTxHash: null })),
      },
      confirm: vi.fn(async () => true),
      now: () => NOW,
      sleep: vi.fn(async () => {}),
      log: () => {},
    };
  }

  it("dry run previews only: nothing is signed or verified", async () => {
    const d = deps();
    const { record } = await b402Selftest({ env, deps: d, dir: null });
    expect(record.outcome).toBe("SIMULATED");
    expect(record.option).toMatchObject({ token: "U", method: "eip3009" });
    expect(d.wallet.x402Sign).not.toHaveBeenCalled();
    expect(d.client.verify).not.toHaveBeenCalled();
  });

  it("live signs a self-payment and calls Verify only, recording B402's reason", async () => {
    const d = deps();
    const { record } = await b402Selftest({ env, live: true, deps: d, dir: null });
    expect(record).toMatchObject({ outcome: "INVALID", verify: { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" }, proof: { acceptedMatches: true, strictDecode: true } });
    expect(vi.mocked(d.client.verify).mock.calls[0]![1]).toEqual(reqsFor()[0]);
    expect(d.client.settle).not.toHaveBeenCalled();
    expect(JSON.stringify(record)).not.toContain("11".repeat(65));
  });

  it("refuses unless payTo is the wallet itself", async () => {
    const { record } = await b402Selftest({ env: { ...env, B402_PAY_TO: BUYER }, live: true, deps: deps(), dir: null });
    expect(record).toMatchObject({ outcome: "REFUSED", refusal: { code: "BAD_PAYMENT_REQUIREMENTS" } });
  });
});
