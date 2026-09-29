import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLICY,
  U_BSC,
  decodePaymentRequired,
  decodePaymentResponse,
  pickOption,
  sameRequirement,
  spentX402TodayUsd,
  x402Fetch,
  x402Preview,
  x402PreviewArgs,
  x402SignArgs,
  type X402Deps,
  type X402Preview,
  type X402Receipt,
} from "../src/index";
import { fixture } from "./helpers";

const W = "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65";
const env = { GAP_WALLET_ADDRESS: W } as NodeJS.ProcessEnv;
const NOW = Date.parse("2026-09-29T18:00:00Z");
const URL_ = "https://stock-agent.bnbchain.org/x402/analyze/async";
const TX = `0x${"ab".repeat(32)}`;

interface Rec {
  required: { status: number; header: string; body: { paymentRequired: unknown } };
  preview: X402Preview;
}
const rec = fixture<Rec>("x402.json");

/** The recorded preview with U funded: U turns READY_TO_SIGN (it needs no approval). */
const fundedPreview = (): X402Preview => ({
  ...rec.preview,
  options: rec.preview.options.map((o) => (o.tokenSymbol === "U" ? { ...o, status: "READY_TO_SIGN", reasons: [], currentBalance: "0.6" } : o)),
});

const accepts = () => decodePaymentRequired(rec.required.header, rec.required.body).required.accepts;

const res402 = () => new Response(JSON.stringify(rec.required.body), { status: 402, headers: { "payment-required": rec.required.header, "content-type": "application/json" } });
const settledHeader = Buffer.from(JSON.stringify({ success: true, transaction: TX, network: "eip155:56", payer: W })).toString("base64");
const res202 = () => new Response(JSON.stringify({ jobId: "job-1", jobToken: "tok-1" }), { status: 202, headers: { "payment-response": settledHeader } });

function deps(o: { preview?: X402Preview; responses?: Array<Response | Error>; confirm?: boolean; approveTxHash?: string } = {}) {
  const responses = [...(o.responses ?? [res402(), res202()])];
  const d: X402Deps = {
    fetch: vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch,
    wallet: {
      x402Preview: vi.fn(async () => o.preview ?? fundedPreview()),
      x402Sign: vi.fn(async () => ({ paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: "c2lnbmVk", signatureExpiresAt: NOW / 1000 + 600, approveTxHash: o.approveTxHash ?? null })),
    },
    confirm: vi.fn(async () => o.confirm ?? true),
    now: () => NOW,
    log: () => {},
  };
  return d;
}

const run = (d: X402Deps, extra: Partial<Parameters<typeof x402Fetch>[2]> = {}) =>
  x402Fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"symbols":["NVDA"]}' }, { label: "research NVDA", env, deps: d, receiptsDir: null, prior: [], ...extra });

describe("x402 requirements and option choice", () => {
  it("decodes the PAYMENT-REQUIRED header, falls back to the body, and rejects anything else", () => {
    const fromHeader = decodePaymentRequired(rec.required.header, null);
    expect(fromHeader.raw).toBe(rec.required.header);
    expect(fromHeader.required.accepts).toHaveLength(4);
    expect(fromHeader.required.resource?.description).toBe("Stock analysis for NVDA");
    const fromBody = decodePaymentRequired(null, rec.required.body);
    expect(fromBody.required.accepts).toEqual(fromHeader.required.accepts);
    expect(() => decodePaymentRequired("not base64 json", { error: "nope" })).toThrow(/no x402 v2 payment requirements/);
  });

  it("refuses the recorded preview: USDT says READY_TO_SIGN but needs a Permit2 approval, U is unfunded", () => {
    expect(rec.preview.options.find((o) => o.tokenSymbol === "USDT")).toMatchObject({ status: "READY_TO_SIGN", needApproveFirst: true });
    let msg = "";
    try {
      pickOption(rec.preview, accepts());
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/USDT: needs a Permit2 approval first/);
    expect(msg).toMatch(/U: ACTION_REQUIRED \(INSUFFICIENT_BALANCE\)/);
  });

  it("picks EIP-3009 U by the preview's own index, ahead of USD1", () => {
    const p = fundedPreview();
    p.options = p.options.map((o) => (o.tokenSymbol === "USD1" ? { ...o, status: "READY_TO_SIGN", reasons: [] } : o)).reverse();
    const o = pickOption(p, accepts());
    expect(o.tokenAddress).toBe(U_BSC);
    expect(o.index).toBe(2);
  });

  it("refuses an option whose originalAccept differs from what the server sent, and ignores key order", () => {
    const p = fundedPreview();
    const u = p.options.find((o) => o.tokenSymbol === "U")!;
    const acc = accepts().find((a) => a.asset === U_BSC)!;
    expect(sameRequirement(acc, u.originalAccept)).toBe(true);
    u.originalAccept = { ...u.originalAccept, amount: "1000000000000000000" };
    expect(() => pickOption(p, accepts())).toThrow(/does not match any requirement/);
  });
});

describe("x402Fetch", () => {
  it("passes a non-402 answer straight through without touching the wallet", async () => {
    const d = deps({ responses: [new Response("ok", { status: 200 })] });
    const r = await run(d);
    expect(r.receipt).toBeNull();
    expect(r.res.status).toBe(200);
    expect(d.wallet.x402Preview).not.toHaveBeenCalled();
  });

  it("dry run previews and picks U, but never signs or replays", async () => {
    const d = deps();
    const { receipt } = await run(d);
    expect(receipt).toMatchObject({ outcome: "SIMULATED", mode: "dry-run", option: { token: "U", index: 2, method: "eip3009", amount: "0.100000000000000000" }, signed: null });
    expect(receipt!.options).toHaveLength(4);
    expect(d.wallet.x402Preview).toHaveBeenCalledWith(rec.required.header);
    expect(d.wallet.x402Sign).not.toHaveBeenCalled();
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("live signs the preview's option, replays with PAYMENT-SIGNATURE and records the settlement", async () => {
    const d = deps();
    const { res, receipt } = await run(d, { live: true });
    expect(d.wallet.x402Sign).toHaveBeenCalledWith(rec.preview.paymentId, 2);
    const replay = vi.mocked(d.fetch).mock.calls[1]!;
    expect(replay[1]).toMatchObject({ method: "POST", body: '{"symbols":["NVDA"]}', headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": "c2lnbmVk" } });
    expect(res.status).toBe(202);
    expect(receipt).toMatchObject({ outcome: "PAID", httpStatus: 202, settlement: { success: true, transaction: TX, bscscan: `https://bscscan.com/tx/${TX}`, payer: W } });
    expect(receipt!.signed!.expiresAt).toBe(new Date(NOW + 600_000).toISOString());
  });

  it("a replay answered with 402 again is FAILED / PAYMENT_REJECTED", async () => {
    const d = deps({ responses: [res402(), new Response('{"error":"invalid signature"}', { status: 402 })] });
    const { receipt, res } = await run(d, { live: true });
    expect(receipt).toMatchObject({ outcome: "FAILED", refusal: { code: "PAYMENT_REJECTED" } });
    expect(receipt!.refusal!.message).toMatch(/invalid signature/);
    expect(res.status).toBe(402);
  });

  it("keeps the public parts of the signed proof, never the signature", async () => {
    const u = accepts().find((a) => a.asset === U_BSC)!;
    const auth = { from: W.toLowerCase(), to: u.payTo, value: u.amount, validAfter: "1790700000", validBefore: "1790700120", nonce: `0x${"77".repeat(32)}` };
    const proof = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: URL_ }, accepted: u, payload: { signature: `0x${"5e".repeat(65)}`, authorization: auth } })).toString("base64");
    const rejected = Buffer.from(JSON.stringify({ success: false, transaction: "", network: "eip155:56", payer: W.toLowerCase(), errorReason: "payment_rejected" })).toString("base64");
    const d = deps({ responses: [res402(), new Response('{"errorCode": "payment_rejected"}', { status: 402, headers: { "payment-response": rejected } })] });
    vi.mocked(d.wallet.x402Sign).mockResolvedValue({ paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: proof, signatureExpiresAt: 1790700120, approveTxHash: null });
    const { receipt } = await run(d, { live: true });
    expect(receipt!.signed!.proof).toEqual({
      x402Version: 2,
      resourceUrl: URL_,
      acceptedMatches: true,
      authorization: { from: auth.from, to: auth.to, value: auth.value, validAfter: auth.validAfter, validBefore: auth.validBefore },
    });
    expect(JSON.stringify(receipt)).not.toContain("5e5e5e");
    expect(receipt!.settlement).toMatchObject({ success: false, transaction: "", errorReason: "payment_rejected" });
    expect(spentX402TodayUsd([receipt!], NOW)).toBeCloseTo(0.1, 2);
  });

  it("waits until the chain is past validAfter before replaying a just-signed proof", async () => {
    const u = accepts().find((a) => a.asset === U_BSC)!;
    const auth = { from: W, to: u.payTo, value: u.amount, validAfter: String(NOW / 1000 + 1), validBefore: String(NOW / 1000 + 121), nonce: `0x${"77".repeat(32)}` };
    const proof = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: URL_ }, accepted: u, payload: { signature: "0x00", authorization: auth } })).toString("base64");
    const d = deps();
    const order: string[] = [];
    d.sleep = vi.fn(async (ms: number) => {
      order.push(`sleep ${ms}`);
    });
    const fetch = d.fetch;
    d.fetch = vi.fn(async (...a: Parameters<typeof globalThis.fetch>) => {
      order.push("fetch");
      return fetch(...a);
    }) as unknown as typeof globalThis.fetch;
    vi.mocked(d.wallet.x402Sign).mockResolvedValue({ paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: proof, signatureExpiresAt: NOW / 1000 + 121, approveTxHash: null });
    const { receipt } = await run(d, { live: true });
    expect(order).toEqual(["fetch", "sleep 4000", "fetch"]);
    expect(receipt!.outcome).toBe("PAID");
    expect(receipt!.steps.map((s) => s.step)).toContain("waiting for validAfter");
  });

  it("a declined prompt signs nothing", async () => {
    const d = deps({ confirm: false });
    const { receipt } = await run(d, { live: true });
    expect(receipt).toMatchObject({ outcome: "REFUSED", refusal: { code: "USER_DECLINED" }, signed: null });
    expect(d.wallet.x402Sign).not.toHaveBeenCalled();
  });

  it("enforces the per-call and daily caps from the receipts", async () => {
    const perCall = await run(deps(), { live: true, policy: { ...DEFAULT_POLICY, x402MaxPerCallUsd: 0.05 } });
    expect(perCall.receipt!.refusal!.code).toBe("X402_PER_CALL_CAP");
    const paid = (usd: number, at: number, outcome: X402Receipt["outcome"] = "PAID", mode: X402Receipt["mode"] = "live") =>
      ({ mode, outcome, createdAt: new Date(at).toISOString(), signed: { headerName: "PAYMENT-SIGNATURE", expiresAt: null, approveTxHash: null }, option: { amountUsd: usd } }) as X402Receipt;
    const prior = [paid(0.5, NOW - 3_600_000), paid(0.45, NOW - 60_000, "FAILED"), paid(0.9, NOW - 86_400_000), paid(0.9, NOW, "SIMULATED", "dry-run")];
    expect(spentX402TodayUsd(prior, NOW)).toBeCloseTo(0.95, 6);
    const d = deps();
    const daily = await run(d, { live: true, prior });
    expect(daily.receipt!.refusal!.code).toBe("X402_DAILY_CAP");
    expect(d.wallet.x402Sign).not.toHaveBeenCalled();
  });

  it("never replays when signing dispatched a Permit2 approval", async () => {
    const d = deps({ approveTxHash: TX });
    const { receipt } = await run(d, { live: true });
    expect(receipt).toMatchObject({ outcome: "FAILED", refusal: { code: "UNEXPECTED_APPROVAL" }, signed: { approveTxHash: TX } });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("a replay lost in transit is PENDING, because the authorization may still settle", async () => {
    const d = deps({ responses: [res402(), new Error("socket hang up")] });
    const { receipt } = await run(d, { live: true });
    expect(receipt).toMatchObject({ outcome: "PENDING", refusal: { code: "REPLAY_UNKNOWN" } });
  });

  it("honours the kill switch before previewing", async () => {
    const d = deps();
    const { receipt } = await run(d, { live: true, env: { ...env, GAP_EXEC_DISABLED: "1" } });
    expect(receipt!.refusal!.code).toBe("EXEC_DISABLED");
    expect(d.wallet.x402Preview).not.toHaveBeenCalled();
  });

  it("decodes PAYMENT-RESPONSE and tolerates garbage", () => {
    expect(decodePaymentResponse(settledHeader)).toMatchObject({ success: true, transaction: TX, network: "eip155:56" });
    expect(decodePaymentResponse("%%%")!.errorReason).toMatch(/unreadable/);
    const cmc = Buffer.from(JSON.stringify({ x402Version: 2, x402FlowId: "4f983af7-2c59-4c70-a8a6-504f1ad6d9a1", resource: "X402_get_global_metrics_latest", status: "settled" })).toString("base64");
    expect(decodePaymentResponse(cmc)).toMatchObject({ success: true, transaction: null });
    expect(decodePaymentResponse(null)).toBeNull();
  });
});

describe("baw x402-payment wrappers", () => {
  it("builds argv and validates ids", () => {
    expect(x402PreviewArgs(` ${rec.required.header} `)).toEqual(["x402-payment", "preview", "--paymentRequirements", rec.required.header]);
    expect(x402SignArgs("9fd545f5-2493-412f-97f8-11d691c9e9bf", 2)).toEqual(["x402-payment", "sign", "--paymentId", "9fd545f5-2493-412f-97f8-11d691c9e9bf", "--selectedIndex", "2"]);
    expect(() => x402SignArgs("id; rm -rf", 1)).toThrow(/Invalid x402 payment id/);
    expect(() => x402SignArgs("abc", -1)).toThrow(/Invalid x402 option index/);
  });

  it("parses the recorded preview through the runner", async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ success: true, data: rec.preview }), stderr: "" }));
    const p = await x402Preview(rec.required.header, runner);
    expect(runner).toHaveBeenCalledWith(["x402-payment", "preview", "--paymentRequirements", rec.required.header, "--json"]);
    expect(p.options.map((o) => `${o.index}:${o.tokenSymbol}`)).toEqual(["1:USDT", "2:U", "3:USD1", "4:USDC"]);
  });
});
