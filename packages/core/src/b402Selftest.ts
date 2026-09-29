import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { b402Config, buildRequirements, createB402Client, decodePaymentPayload, describeB402Error, priceToAmount, type B402Client } from "./b402";
import { createBawWallet, type BawWallet } from "./bawWallet";
import { Refusal, commonRails, lower, type ExecMode, type RefusalCode } from "./execute";
import { pickOption, sameRequirement, summarizeProof, VALID_AFTER_MARGIN_MS, type PaymentRequired, type PaymentRequirement, type ProofSummary } from "./x402";

export const SELFTEST_RESOURCE = "https://executable-gap-desk.vercel.app/x402/gap/NVDA";
export const SELFTEST_PRICE_U = "0.01";

export interface SelftestRecord {
  version: 1;
  kind: "b402-selftest";
  createdAt: string;
  mode: ExecMode;
  outcome: "VALID" | "INVALID" | "SIMULATED" | "REFUSED" | "ERROR";
  refusal: { code: RefusalCode | "ERROR"; message: string } | null;
  wallet: string;
  payTo: string | null;
  resource: string;
  requirements: PaymentRequirement[];
  option: { index: number; token: string; method: string; amount: string } | null;
  proof: (ProofSummary & { strictDecode: boolean }) | null;
  verify: { isValid: boolean; invalidReason: string | null; invalidMessage: string | null; payer: string | null } | null;
  steps: Array<{ at: string; step: string; detail?: string }>;
}

export interface SelftestDeps {
  client: B402Client;
  wallet: Pick<BawWallet, "x402Preview" | "x402Sign">;
  confirm(summary: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(step: string, detail?: string): void;
}

export interface SelftestOptions {
  live?: boolean;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<SelftestDeps>;
  /** `receipts/b402`; null in tests. */
  dir: string | null;
}

/**
 * Free diagnostic: the desk's own 0.01 U requirement, paid by the Agentic Wallet to itself, signed with
 * baw and sent to B402 Verify only. Verify is off-chain, and Settle is never called, so nothing moves;
 * even a leaked authorization could only transfer the wallet's U to itself. B402's answer is the
 * facilitator-side reason a seller like the Stock Agent hides behind "payment_rejected".
 */
export async function b402Selftest(opts: SelftestOptions): Promise<{ record: SelftestRecord; path: string | null }> {
  const env = opts.env ?? process.env;
  const cfg = b402Config(env);
  const client = opts.deps?.client ?? (cfg.creds ? createB402Client(cfg.creds) : null);
  const d: Omit<SelftestDeps, "client"> = {
    wallet: opts.deps?.wallet ?? createBawWallet(),
    confirm: async () => false,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
    ...opts.deps,
  };
  const wallet = env.GAP_WALLET_ADDRESS ?? "";
  const now = d.now();
  const r: SelftestRecord = {
    version: 1,
    kind: "b402-selftest",
    createdAt: new Date(now).toISOString(),
    mode: opts.live ? "live" : "dry-run",
    outcome: "REFUSED",
    refusal: null,
    wallet,
    payTo: cfg.payTo,
    resource: SELFTEST_RESOURCE,
    requirements: [],
    option: null,
    proof: null,
    verify: null,
    steps: [],
  };
  const step = (s: string, detail?: string) => {
    r.steps.push({ at: new Date(d.now()).toISOString(), step: s, ...(detail ? { detail } : {}) });
    d.log(s, detail);
  };
  const finish = (err?: unknown) => {
    if (err !== undefined) {
      const code = err instanceof Refusal ? err.code : "ERROR";
      r.refusal = { code, message: err instanceof Refusal ? err.message : describeB402Error(err) };
      r.outcome = code === "ERROR" ? "ERROR" : "REFUSED";
      step("stopped", `${code}: ${r.refusal.message}`);
    }
    let path: string | null = null;
    if (opts.dir) {
      mkdirSync(opts.dir, { recursive: true });
      path = join(opts.dir, `${r.createdAt.replace(/[:.]/g, "-")}-b402-selftest.json`);
      writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`);
    }
    return { record: r, path };
  };

  try {
    commonRails(env, wallet);
    if (!client) throw new Refusal("BAD_PAYMENT_REQUIREMENTS", `B402 is not configured: missing ${cfg.missing.join(", ")}.`);
    if (!cfg.payTo || lower(cfg.payTo) !== lower(wallet)) {
      throw new Refusal("BAD_PAYMENT_REQUIREMENTS", `The self-test only runs when payTo is the wallet itself (payTo ${cfg.payTo ?? "unset"}, wallet ${wallet}).`);
    }
    const kinds = (await client.supported()).kinds;
    r.requirements = buildRequirements(kinds, { amount: priceToAmount(SELFTEST_PRICE_U), payTo: cfg.payTo });
    step("supported", `${kinds.length} kinds; ${r.requirements.length} EIP-3009 requirement(s)`);
    if (!r.requirements.length) throw new Refusal("NO_PAYABLE_OPTION", "B402 offers no EIP-3009 kind for U or USD1.");
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: SELFTEST_RESOURCE, description: "B402 self-test (verify only)", mimeType: "application/json" },
      accepts: r.requirements,
    };

    const preview = await d.wallet.x402Preview(Buffer.from(JSON.stringify(required)).toString("base64"));
    const o = pickOption(preview, r.requirements);
    const requirement = r.requirements.find((a) => sameRequirement(a, o.originalAccept))!;
    const method = String((requirement.extra as Record<string, unknown> | undefined)?.assetTransferMethod ?? o.assetTransferMethod ?? "");
    r.option = { index: o.index, token: o.tokenSymbol ?? o.tokenAddress, method, amount: o.amount };
    step("wallet preview", `${preview.options.length} options; picked ${r.option.amount} ${r.option.token} via ${method}`);

    if (!opts.live) {
      r.outcome = "SIMULATED";
      step("dry run: previewed; not signed");
      return finish();
    }
    const summary = `Sign a ${o.amount} ${r.option.token} x402 authorization from ${wallet} to itself and send it to B402 Verify only (never Settle)?`;
    if (!(await d.confirm(summary))) throw new Refusal("USER_DECLINED", "Declined at the confirmation prompt.");

    step("sign");
    const signed = await d.wallet.x402Sign(preview.paymentId, o.index);
    if (signed.approveTxHash) throw new Refusal("UNEXPECTED_APPROVAL", `Signing dispatched an approval (${signed.approveTxHash}).`);
    const strict = decodePaymentPayload(signed.paymentHeaderValue);
    const summaryOfProof = summarizeProof(signed.paymentHeaderValue, requirement);
    r.proof = summaryOfProof ? { ...summaryOfProof, strictDecode: strict !== null } : null;
    step("proof", `${r.proof?.acceptedMatches ? "accepted = requirement" : "accepted DIFFERS"}; strict decode ${strict ? "ok" : "FAILED"}`);

    const validAfter = Number(r.proof?.authorization?.validAfter);
    const wait = Number.isFinite(validAfter) ? validAfter * 1000 + VALID_AFTER_MARGIN_MS - d.now() : 0;
    if (wait > 0) {
      step("waiting for validAfter", `${(Math.min(wait, 10_000) / 1000).toFixed(1)}s`);
      await d.sleep(Math.min(wait, 10_000));
    }

    const payload = strict ?? JSON.parse(Buffer.from(signed.paymentHeaderValue, "base64").toString("utf8"));
    step("B402 verify");
    const v = await client.verify(payload, requirement);
    r.verify = { isValid: v.isValid, invalidReason: v.invalidReason ?? null, invalidMessage: v.invalidMessage ?? null, payer: v.payer ?? null };
    r.outcome = v.isValid ? "VALID" : "INVALID";
    step("verified", v.isValid ? `isValid, payer ${v.payer ?? "?"}` : `${v.invalidReason ?? "?"}${v.invalidMessage ? `: ${v.invalidMessage}` : ""}`);
    return finish();
  } catch (err) {
    return finish(err);
  }
}
