import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createBawWallet, type BawWallet, type X402Option, type X402Preview } from "./bawWallet";
import { bscTxUrl } from "./chain";
import { USD1_BSC, U_BSC } from "./config";
import { Refusal, commonRails, type ExecMode, type RefusalCode } from "./execute";
import { DEFAULT_POLICY, type Policy } from "./gate";

export const PaymentRequirementSchema = z.looseObject({
  scheme: z.string(),
  network: z.string(),
  amount: z.string(),
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequirement = z.infer<typeof PaymentRequirementSchema>;

export const PaymentRequiredSchema = z.looseObject({
  x402Version: z.literal(2),
  accepts: z.array(PaymentRequirementSchema).min(1),
  resource: z.looseObject({ url: z.string().optional(), description: z.string().optional(), mimeType: z.string().optional() }).optional(),
  error: z.string().optional(),
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

const b64json = (s: string): unknown => JSON.parse(Buffer.from(s.trim(), "base64").toString("utf8"));

/**
 * The server's payment requirements: the base64 `PAYMENT-REQUIRED` header when present, otherwise
 * `body.paymentRequired` or the body itself. `raw` is what is handed to `baw x402-payment preview`.
 */
export function decodePaymentRequired(header: string | null, body: unknown): { required: PaymentRequired; raw: string } {
  const candidates: Array<{ value: unknown; raw: () => string }> = [];
  if (header) {
    try {
      candidates.push({ value: b64json(header), raw: () => header.trim() });
    } catch {
      // fall through to the body
    }
  }
  const b = body as { paymentRequired?: unknown } | null;
  if (b && typeof b === "object" && b.paymentRequired) candidates.push({ value: b.paymentRequired, raw: () => JSON.stringify(b.paymentRequired) });
  if (b && typeof b === "object") candidates.push({ value: b, raw: () => JSON.stringify(b) });
  for (const c of candidates) {
    const p = PaymentRequiredSchema.safeParse(c.value);
    if (p.success) return { required: p.data, raw: c.raw() };
  }
  throw new Refusal("BAD_PAYMENT_REQUIREMENTS", "The 402 response carries no x402 v2 payment requirements.");
}

const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

/** Deep equality ignoring key order (the wallet's preview reorders `extra`). */
export const sameRequirement = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** The server's `extra.assetTransferMethod` (e.g. `permit2-exact`) is more precise than the preview's (`permit2`). */
const methodOf = (o: X402Option) => {
  const m = (o.originalAccept.extra as Record<string, unknown> | undefined)?.assetTransferMethod;
  return typeof m === "string" ? m : (o.assetTransferMethod ?? "");
};
const isEip3009 = (o: X402Option) => methodOf(o).toLowerCase() === "eip3009";

/**
 * Picks the option to sign. It must be READY_TO_SIGN, need no approval, and match a requirement the
 * server sent. READY_TO_SIGN alone is not enough: the preview marks Permit2 options ready while
 * `needApproveFirst` is true, and signing one makes baw dispatch an approval transaction.
 * Preference: EIP-3009 U, then EIP-3009 USD1, then anything else that qualifies.
 */
export function pickOption(preview: X402Preview, accepts: PaymentRequirement[]): X402Option {
  const why: string[] = [];
  const ok: X402Option[] = [];
  for (const o of preview.options) {
    const name = o.tokenSymbol ?? o.tokenAddress;
    const needsApproval = o.needApproveFirst ?? !isEip3009(o);
    if (o.status !== "READY_TO_SIGN") why.push(`${name}: ${o.status}${o.reasons.length ? ` (${o.reasons.join(", ")})` : ""}`);
    else if (needsApproval) why.push(`${name}: needs a Permit2 approval first, which this desk never grants`);
    else if (!accepts.some((a) => sameRequirement(a, o.originalAccept))) why.push(`${name}: the wallet's option does not match any requirement the server sent`);
    else ok.push(o);
  }
  const rank = (o: X402Option) => {
    const token = o.tokenAddress.toLowerCase();
    if (isEip3009(o) && token === U_BSC.toLowerCase()) return 0;
    if (isEip3009(o) && token === USD1_BSC.toLowerCase()) return 1;
    return isEip3009(o) ? 2 : 3;
  };
  const best = ok.sort((a, b) => rank(a) - rank(b))[0];
  if (!best) throw new Refusal("NO_PAYABLE_OPTION", `No payment option can be signed safely: ${why.join("; ") || "none offered"}.`);
  return best;
}

export const optionUsd = (o: X402Option) => (o.amountUsd !== null && o.amountUsd !== undefined && Number.isFinite(o.amountUsd) ? o.amountUsd : Number(o.amount));

// ---------- receipts ----------

export type X402Outcome = "PAID" | "SIMULATED" | "REFUSED" | "FAILED" | "PENDING";

export interface X402Settlement {
  success: boolean | null;
  transaction: string | null;
  network: string | null;
  payer: string | null;
  bscscan: string | null;
  errorReason: string | null;
  raw: unknown;
}

export interface X402Receipt {
  version: 1;
  id: string;
  kind: "x402";
  createdAt: string;
  mode: ExecMode;
  outcome: X402Outcome;
  refusal: { code: RefusalCode | "ERROR"; message: string } | null;
  /** What the payment bought, e.g. "research NVDA". */
  label: string;
  wallet: string;
  url: string;
  method: string;
  resource: PaymentRequired["resource"] | null;
  paymentId: string | null;
  /** Every option the wallet offered, and why each was or wasn't usable. */
  options: Array<{ index: number; token: string; method: string; status: string; reasons: string[]; needApproveFirst: boolean | null; amount: string }>;
  option: { index: number; token: string; tokenAddress: string; method: string; amount: string; amountUsd: number; payTo: string; network: string } | null;
  signed: { headerName: string; expiresAt: string | null; approveTxHash: string | null; proof?: ProofSummary | null } | null;
  settlement: X402Settlement | null;
  httpStatus: number | null;
  steps: Array<{ at: string; step: string; detail?: string }>;
}

export function x402ReceiptId(label: string, now: number): string {
  return `${new Date(now).toISOString().replace(/[:.]/g, "-")}-x402-${label.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`;
}

export function writeX402Receipt(dir: string, r: X402Receipt): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${r.id}.json`);
  writeFileSync(path, `${JSON.stringify(r, null, 2)}\n`);
  return path;
}

export function listX402Receipts(dir: string): X402Receipt[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as X402Receipt);
}

/**
 * USD committed to x402 calls on the UTC day of `now`: every live receipt that got as far as a
 * signature. A seller's "rejected" is unverified and the authorization stays valid until it
 * expires, so a signed failure still counts.
 */
export function spentX402TodayUsd(receipts: X402Receipt[], now: number): number {
  const day = new Date(now).toISOString().slice(0, 10);
  return receipts
    .filter((r) => r.mode === "live" && r.signed && r.option && r.createdAt.slice(0, 10) === day)
    .filter((r) => r.outcome === "PAID" || r.outcome === "FAILED" || r.outcome === "PENDING")
    .reduce((sum, r) => sum + r.option!.amountUsd, 0);
}

/** The public parts of a signed proof; the signature itself is never kept. */
export interface ProofSummary {
  x402Version: unknown;
  resourceUrl: string | null;
  acceptedMatches: boolean;
  authorization: Record<string, string> | null;
}

/** Summarize a base64 `PAYMENT-SIGNATURE` value against the requirement that was picked. */
export function summarizeProof(headerValue: string, accepted: PaymentRequirement): ProofSummary | null {
  let p: Record<string, unknown>;
  try {
    const v = b64json(headerValue);
    if (!v || typeof v !== "object") return null;
    p = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const payload = (p.payload && typeof p.payload === "object" ? p.payload : {}) as Record<string, unknown>;
  const auth = (payload.authorization ?? payload.permit2Authorization) as Record<string, unknown> | undefined;
  const keep = ["from", "to", "value", "validAfter", "validBefore", "deadline", "spender"];
  const resource = (p.resource && typeof p.resource === "object" ? p.resource : {}) as Record<string, unknown>;
  return {
    x402Version: p.x402Version,
    resourceUrl: typeof resource.url === "string" ? resource.url : null,
    acceptedMatches: sameRequirement(p.accepted, accepted),
    authorization: auth && typeof auth === "object" ? Object.fromEntries(keep.filter((k) => auth[k] !== undefined).map((k) => [k, String(auth[k])])) : null,
  };
}

/** Settlement details from the base64 `PAYMENT-RESPONSE` header, if any. */
export function decodePaymentResponse(header: string | null): X402Settlement | null {
  if (!header) return null;
  let raw: unknown;
  try {
    raw = b64json(header);
  } catch {
    return { success: null, transaction: null, network: null, payer: null, bscscan: null, errorReason: "unreadable PAYMENT-RESPONSE header", raw: header };
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tx = typeof o.transaction === "string" ? o.transaction : typeof o.txHash === "string" ? o.txHash : null;
  // Some sellers (CoinMarketCap) answer `{x402FlowId, status: "settled"}` instead of `{success, transaction}`.
  const status = typeof o.status === "string" ? o.status.toLowerCase() : null;
  const success = typeof o.success === "boolean" ? o.success : status === "settled" || status === "success" ? true : status === "failed" || status === "rejected" ? false : null;
  return {
    success,
    transaction: tx,
    network: typeof o.network === "string" ? o.network : null,
    payer: typeof o.payer === "string" ? o.payer : null,
    bscscan: tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? bscTxUrl(tx) : null,
    errorReason: typeof o.errorReason === "string" ? o.errorReason : null,
    raw,
  };
}

// ---------- the paid fetch ----------

export interface X402Deps {
  fetch: typeof fetch;
  wallet: Pick<BawWallet, "x402Preview" | "x402Sign">;
  /** Final human check before signing; the CLI prompts unless `--yes`. */
  confirm(summary: string): Promise<boolean>;
  now(): number;
  log(step: string, detail?: string): void;
  sleep?(ms: number): Promise<void>;
}

export function defaultX402Deps(): X402Deps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    wallet: createBawWallet(),
    confirm: async () => false,
    now: Date.now,
    log: () => {},
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * EIP-3009 needs `block.timestamp > validAfter`, and BSC packs several blocks into one second. A proof
 * replayed in the second it was signed can be simulated against a block that is not yet past it.
 */
export const VALID_AFTER_MARGIN_MS = 3000;
const MAX_VALID_AFTER_WAIT_MS = 10_000;

export interface X402Request {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface X402FetchOptions {
  label: string;
  live?: boolean;
  policy?: Policy;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<X402Deps>;
  /** `receipts/x402`; null in tests. Also the source of today's spend unless `prior` is given. */
  receiptsDir: string | null;
  prior?: X402Receipt[];
}

export interface X402Result {
  /** The replayed response when paid; otherwise the first response (a 402, or a non-402 passed through). */
  res: Response;
  receipt: X402Receipt | null;
  path: string | null;
}

const REPLAY_HEADERS = new Set(["payment-signature", "x-payment"]);

/**
 * Fetch that pays x402 through the Agentic Wallet. A 402 is previewed with `baw x402-payment preview`,
 * a safe option is picked, the per-call and daily caps are enforced, and only a live run with a
 * confirmation signs and replays. Every paid attempt writes a receipt before the body is read.
 */
export async function x402Fetch(url: string, init: X402Request, opts: X402FetchOptions): Promise<X402Result> {
  const d: X402Deps = { ...defaultX402Deps(), ...opts.deps };
  const policy = opts.policy ?? DEFAULT_POLICY;
  const env = opts.env ?? process.env;
  const wallet = env.GAP_WALLET_ADDRESS ?? "";
  const method = (init.method ?? "GET").toUpperCase();
  const now = d.now();
  const r: X402Receipt = {
    version: 1,
    id: x402ReceiptId(opts.label, now),
    kind: "x402",
    createdAt: new Date(now).toISOString(),
    mode: opts.live ? "live" : "dry-run",
    outcome: "REFUSED",
    refusal: null,
    label: opts.label,
    wallet,
    url,
    method,
    resource: null,
    paymentId: null,
    options: [],
    option: null,
    signed: null,
    settlement: null,
    httpStatus: null,
    steps: [],
  };
  const step = (s: string, detail?: string) => {
    r.steps.push({ at: new Date(d.now()).toISOString(), step: s, ...(detail ? { detail } : {}) });
    d.log(s, detail);
  };
  const finish = (res: Response, err?: unknown): X402Result => {
    if (err !== undefined) {
      const code = err instanceof Refusal ? err.code : "ERROR";
      r.refusal = { code, message: err instanceof Error ? err.message : String(err) };
      if (r.outcome !== "FAILED" && r.outcome !== "PENDING") r.outcome = r.signed ? "FAILED" : "REFUSED";
      step(r.outcome === "REFUSED" ? "refused" : "stopped", `${code}: ${r.refusal.message}`);
    }
    return { res, receipt: r, path: opts.receiptsDir ? writeX402Receipt(opts.receiptsDir, r) : null };
  };

  const first = await d.fetch(url, { method, headers: init.headers, body: init.body });
  if (first.status !== 402) return { res: first, receipt: null, path: null };
  r.httpStatus = 402;
  step("402 payment required");
  let current = first;
  try {
    commonRails(env, wallet);
    const body = await first.clone().json().catch(() => null);
    const { required, raw } = decodePaymentRequired(first.headers.get("payment-required"), body);
    r.resource = required.resource ?? null;

    const preview = await d.wallet.x402Preview(raw);
    r.paymentId = preview.paymentId;
    r.options = preview.options.map((o) => ({
      index: o.index,
      token: o.tokenSymbol ?? o.tokenAddress,
      method: methodOf(o),
      status: o.status,
      reasons: o.reasons,
      needApproveFirst: o.needApproveFirst ?? null,
      amount: o.amount,
    }));
    step("wallet preview", `${preview.options.length} options`);
    const o = pickOption(preview, required.accepts);
    const usd = optionUsd(o);
    const acc = PaymentRequirementSchema.parse(o.originalAccept);
    r.option = { index: o.index, token: o.tokenSymbol ?? o.tokenAddress, tokenAddress: o.tokenAddress, method: methodOf(o), amount: o.amount, amountUsd: usd, payTo: acc.payTo, network: acc.network };
    step("option picked", `${o.amount} ${r.option.token} via ${r.option.method} to ${acc.payTo}`);

    if (!(usd > 0)) throw new Refusal("BAD_PAYMENT_REQUIREMENTS", `The payment amount ${o.amount} is not positive.`);
    if (usd > policy.x402MaxPerCallUsd) throw new Refusal("X402_PER_CALL_CAP", `This call costs $${usd.toFixed(4)}, over the $${policy.x402MaxPerCallUsd} per-call cap.`);
    const spent = spentX402TodayUsd(opts.prior ?? (opts.receiptsDir ? listX402Receipts(opts.receiptsDir) : []), now);
    if (spent + usd > policy.maxDailyX402Usd) {
      throw new Refusal("X402_DAILY_CAP", `$${spent.toFixed(4)} already paid today; $${usd.toFixed(4)} more would pass the $${policy.maxDailyX402Usd} daily x402 cap.`);
    }

    if (!opts.live) {
      r.outcome = "SIMULATED";
      step("dry run: preview checked; not signed");
      return finish(first);
    }

    const what = required.resource?.description ?? url;
    const summary = `Pay ${o.amount} ${r.option.token} (${r.option.method}, about $${usd.toFixed(4)}) to ${acc.payTo} for "${what}"?\nToday's x402 spend would be $${(spent + usd).toFixed(4)} of $${policy.maxDailyX402Usd}.`;
    if (!(await d.confirm(summary))) throw new Refusal("USER_DECLINED", "Declined at the confirmation prompt.");

    step("sign");
    const signed = await d.wallet.x402Sign(preview.paymentId, o.index);
    r.signed = {
      headerName: signed.paymentHeaderName,
      expiresAt: signed.signatureExpiresAt ? new Date(Number(signed.signatureExpiresAt) * 1000).toISOString() : null,
      approveTxHash: signed.approveTxHash ?? null,
      proof: summarizeProof(signed.paymentHeaderValue, acc),
    };
    if (signed.approveTxHash) {
      r.outcome = "FAILED";
      throw new Refusal("UNEXPECTED_APPROVAL", `Signing dispatched a Permit2 approval (${signed.approveTxHash}); the payment was not replayed.`);
    }
    if (!REPLAY_HEADERS.has(signed.paymentHeaderName.toLowerCase())) {
      r.outcome = "FAILED";
      throw new Refusal("BAD_PAYMENT_REQUIREMENTS", `baw returned an unexpected replay header name: ${signed.paymentHeaderName}.`);
    }

    const validAfter = Number(r.signed.proof?.authorization?.validAfter);
    const wait = Number.isFinite(validAfter) ? validAfter * 1000 + VALID_AFTER_MARGIN_MS - d.now() : 0;
    if (wait > 0 && d.sleep) {
      step("waiting for validAfter", `${(Math.min(wait, MAX_VALID_AFTER_WAIT_MS) / 1000).toFixed(1)}s`);
      await d.sleep(Math.min(wait, MAX_VALID_AFTER_WAIT_MS));
    }

    step("replay", signed.paymentHeaderName);
    let second: Response;
    try {
      second = await d.fetch(url, { method, headers: { ...init.headers, [signed.paymentHeaderName]: signed.paymentHeaderValue }, body: init.body });
    } catch (err) {
      r.outcome = "PENDING";
      throw new Refusal("REPLAY_UNKNOWN", `The paid request failed in transit (${err instanceof Error ? err.message : String(err)}); the signed authorization may still settle until ${r.signed.expiresAt ?? "it expires"}.`);
    }
    current = second;
    r.httpStatus = second.status;
    r.settlement = decodePaymentResponse(second.headers.get("payment-response"));
    if (r.settlement) step("settlement", r.settlement.transaction ?? r.settlement.errorReason ?? "no transaction");
    if (second.ok) {
      r.outcome = "PAID";
      step("paid", `HTTP ${second.status}`);
      return finish(second);
    }
    r.outcome = "FAILED";
    const text = (await second.clone().text().catch(() => "")).slice(0, 300);
    if (second.status === 402) throw new Refusal("PAYMENT_REJECTED", `The server rejected the payment (HTTP 402): ${text}`);
    throw new Refusal("PAID_BUT_ERROR", `HTTP ${second.status} after paying${r.settlement?.transaction ? ` (settled in ${r.settlement.transaction})` : ""}: ${text}`);
  } catch (err) {
    return finish(current, err);
  }
}
