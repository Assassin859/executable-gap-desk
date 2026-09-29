import { parseUnits } from "viem";
import { z } from "zod";
import { USD1_BSC, U_BSC } from "./config";
import { ApiError } from "./http";
import { signedPost, type Credentials } from "./signer";
import { PaymentRequirementSchema, sameRequirement, type PaymentRequired, type PaymentRequirement } from "./x402";

export const B402_PATHS = {
  supported: "/api/v2/b402/supported",
  verify: "/api/v2/b402/verify",
  settle: "/api/v2/b402/settle",
} as const;

export const B402_NETWORK = "eip155:56";

/**
 * B402 runs under the same Developer Portal project as the rest of the keyed API, so the BW3 pair
 * works once onboarding is done; a dedicated B402_* pair wins when set.
 */
export function b402CredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials | null {
  const dedicated = { apiKey: env.B402_API_KEY?.trim() ?? "", apiSecret: env.B402_API_SECRET?.trim() ?? "" };
  if (dedicated.apiKey && dedicated.apiSecret) return dedicated;
  const shared = { apiKey: env.BW3_API_KEY?.trim() ?? "", apiSecret: env.BW3_API_SECRET?.trim() ?? "" };
  return shared.apiKey && shared.apiSecret ? shared : null;
}

const isAddress = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

export interface B402Config {
  creds: Credentials | null;
  /** The receiving address fixed at onboarding: `B402_PAY_TO`, else the desk's own `GAP_WALLET_ADDRESS`. */
  payTo: string | null;
  missing: string[];
}

/** What a seller needs before it can charge: credentials and the onboarded receiving address. */
export function b402Config(env: NodeJS.ProcessEnv = process.env): B402Config {
  const missing: string[] = [];
  const creds = b402CredentialsFromEnv(env);
  if (!creds) missing.push("B402_API_KEY/B402_API_SECRET (or BW3_API_KEY/BW3_API_SECRET)");
  const payTo = (env.B402_PAY_TO || env.GAP_WALLET_ADDRESS || "").trim();
  if (!isAddress(payTo)) missing.push("B402_PAY_TO");
  return { creds, payTo: isAddress(payTo) ? payTo : null, missing };
}

// ---------- schemas ----------

export const B402KindSchema = z.looseObject({
  x402Version: z.number(),
  scheme: z.string(),
  network: z.string(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type B402Kind = z.infer<typeof B402KindSchema>;

export const B402SupportedSchema = z.looseObject({
  kinds: z.array(B402KindSchema),
  extensions: z.array(z.unknown()).optional(),
  signers: z.record(z.string(), z.array(z.string())).optional(),
});
export type B402Supported = z.infer<typeof B402SupportedSchema>;

export const B402VerifySchema = z.looseObject({
  isValid: z.boolean(),
  invalidReason: z.string().nullish(),
  invalidMessage: z.string().nullish(),
  payer: z.string().nullish(),
});
export type B402Verify = z.infer<typeof B402VerifySchema>;

export const B402SettleSchema = z.looseObject({
  success: z.boolean(),
  transaction: z.string().nullish(),
  network: z.string().nullish(),
  payer: z.string().nullish(),
  amount: z.string().nullish(),
  errorReason: z.string().nullish(),
  errorMessage: z.string().nullish(),
});
export type B402Settle = z.infer<typeof B402SettleSchema>;

/** Envelope codes from the B402 error table; the HTTP status is 200 for most of them. */
export const B402_CODES: Readonly<Record<string, string>> = {
  "1160101": "system error",
  "1160102": "system busy; retry later",
  "1160103": "illegal request parameter",
  "1160104": "RPC chain ID does not match the configured network",
  "1160201": "data not found",
  "1160202": "duplicate data",
  "1160301": "invalid status",
  "1160401": "merchant not found; complete B402 onboarding in the project that owns the API key",
  "1160402": "merchant account is disabled",
  "1160403": "amount exceeds the single-transaction limit",
  "1160404": "amount exceeds the merchant daily limit",
  "1160405": "amount exceeds the payer daily limit",
  "1160406": "payer address is blocked",
  "1160407": "address rejected by sanctions controls",
  "1160408": "B402 merchant rate limit exceeded",
  "1160409": "daily gas-sponsored settlement budget reached",
  "40102": "bad signature (check the /build prefix and raw body)",
  "40103": "signature replayed",
  "40104": "access policy rejected the call (B402 Payments permission or IP whitelist)",
};

/** One line for logs and 402 bodies; never includes credentials or the request body. */
export function describeB402Error(err: unknown): string {
  if (err instanceof ApiError) {
    const code = err.code === null ? null : String(err.code);
    const known = code ? B402_CODES[code] : undefined;
    return `B402 ${err.endpoint}: ${code ?? `HTTP ${err.httpStatus ?? "network"}`}${known ? ` (${known})` : ""}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------- client ----------

export type B402Post = (path: string, body: unknown) => Promise<unknown>;

export interface B402Client {
  supported(): Promise<B402Supported>;
  verify(paymentPayload: unknown, paymentRequirements: PaymentRequirement): Promise<B402Verify>;
  settle(paymentPayload: unknown, paymentRequirements: PaymentRequirement): Promise<B402Settle>;
}

/**
 * Every call is `POST {"body": ...}`, HMAC-signed over the exact raw body. Settle is idempotent for
 * the same authorization, so the signer's bounded re-signed retries on 429/5xx are safe.
 */
export function createB402Client(creds: Credentials, post?: B402Post): B402Client {
  const send: B402Post = post ?? ((path, body) => signedPost(path, { body }, creds, { timeoutMs: 20_000, retries: 2, endpoint: path }));
  return {
    supported: async () => B402SupportedSchema.parse(await send(B402_PATHS.supported, {})),
    verify: async (paymentPayload, paymentRequirements) =>
      B402VerifySchema.parse(await send(B402_PATHS.verify, { x402Version: 2, paymentPayload, paymentRequirements })),
    settle: async (paymentPayload, paymentRequirements) =>
      B402SettleSchema.parse(await send(B402_PATHS.settle, { x402Version: 2, paymentPayload, paymentRequirements })),
  };
}

// ---------- requirements ----------

/** The tokens this desk sells for, in preference order; B402 kinds name them only by EIP-712 domain. */
export const B402_TOKENS: ReadonlyArray<{ symbol: "U" | "USD1"; address: string; domainName: string }> = [
  { symbol: "U", address: U_BSC, domainName: "United Stables" },
  { symbol: "USD1", address: USD1_BSC, domainName: "World Liberty Financial USD" },
];

export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

/** "0.01" U (18 decimals) as a smallest-unit decimal string. */
export const priceToAmount = (priceU: string): string => parseUnits(priceU, 18).toString();

/**
 * Exact EIP-3009 requirements on BSC: U first, USD1 as the fallback. `extra` is copied verbatim from
 * `/supported` (signer, name and version change when B402 rotates them). Permit2 kinds are left out:
 * they need a buyer approval first, which the desk's own buyer refuses to grant.
 */
export function buildRequirements(
  kinds: B402Kind[],
  opts: { amount: string; payTo: string; maxTimeoutSeconds?: number },
): PaymentRequirement[] {
  const out: PaymentRequirement[] = [];
  for (const t of B402_TOKENS) {
    const kind = kinds.find(
      (k) =>
        k.x402Version === 2 &&
        k.scheme === "exact" &&
        k.network === B402_NETWORK &&
        k.extra?.name === t.domainName &&
        k.extra?.assetTransferMethod === "eip3009" &&
        isAddress(k.extra?.signerAddress),
    );
    if (!kind?.extra) continue;
    out.push({
      scheme: "exact",
      network: B402_NETWORK,
      amount: opts.amount,
      asset: t.address,
      payTo: opts.payTo,
      maxTimeoutSeconds: opts.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
      extra: { ...kind.extra },
    });
  }
  return out;
}

export interface B402Readiness {
  kinds: number;
  /** Every offered kind, e.g. "United Stables exact/eip3009". */
  offers: string[];
  /** The tokens this seller can actually charge in (EIP-3009, no buyer approval). */
  sellable: Array<"U" | "USD1">;
  signers: string[];
}

/** A `/supported` call: proves the key, the B402 permission and onboarding, and lists what can be sold. */
export async function b402Ready(client: Pick<B402Client, "supported">): Promise<B402Readiness> {
  const s = await client.supported();
  const probe = buildRequirements(s.kinds, { amount: "1", payTo: "0x0000000000000000000000000000000000000001" });
  return {
    kinds: s.kinds.length,
    offers: s.kinds.map((k) => `${String(k.extra?.name ?? "?")} ${k.scheme}/${String(k.extra?.assetTransferMethod ?? "?")} (${k.network}, v${k.x402Version})`),
    sellable: B402_TOKENS.filter((t) => probe.some((r) => r.asset === t.address)).map((t) => t.symbol),
    signers: [...new Set(Object.values(s.signers ?? {}).flat())],
  };
}

// ---------- proofs ----------

/** A real EIP-3009 proof is about 1 KB of base64; anything far larger is refused before parsing. */
export const MAX_PROOF_BYTES = 8192;

const AuthorizationSchema = z.looseObject({
  from: z.string(),
  to: z.string(),
  value: z.string(),
  validAfter: z.union([z.string(), z.number()]),
  validBefore: z.union([z.string(), z.number()]),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export const PaymentPayloadSchema = z.looseObject({
  x402Version: z.literal(2),
  accepted: PaymentRequirementSchema,
  payload: z.looseObject({ signature: z.string().min(1), authorization: AuthorizationSchema }),
  resource: z.looseObject({ url: z.string().optional() }).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

/** Strict decode of a base64 `PAYMENT-SIGNATURE` value; null when it is not an EIP-3009 x402 v2 proof. */
export function decodePaymentPayload(headerValue: string): PaymentPayload | null {
  if (headerValue.length > MAX_PROOF_BYTES || !/^[A-Za-z0-9+/=\s_-]+$/.test(headerValue)) return null;
  try {
    const parsed = PaymentPayloadSchema.safeParse(JSON.parse(Buffer.from(headerValue.trim(), "base64").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

/**
 * Remembers settled authorization nonces until they expire. Settle is idempotent, so without this a
 * replayed proof would settle "again" (same transaction) and be served twice. In-memory only: it
 * covers one server instance, and the on-chain nonce stops a second transfer anywhere.
 */
export function createNonceGuard(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return {
    has(nonce: string): boolean {
      const t = now();
      for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
      return seen.has(nonce.toLowerCase());
    },
    add(nonce: string, expiresAtMs: number) {
      seen.set(nonce.toLowerCase(), expiresAtMs);
    },
  };
}
export type NonceGuard = ReturnType<typeof createNonceGuard>;

// ---------- the seller ----------

export interface Bazaar {
  description?: string;
  routeTemplate?: string;
  info: { input: { type: "http"; method: string; pathParams?: Record<string, string>; queryParams?: Record<string, string> } };
  schema: Record<string, unknown>;
}

export interface SellOptions {
  priceU: string;
  resource: { url: string; description: string; mimeType: string };
  bazaar?: Bazaar;
  /** Base64 proof from `PAYMENT-SIGNATURE` (or legacy `X-PAYMENT`); null asks for payment. */
  proof: string | null;
  /** Runs after Verify and before Settle, so a failed job is never charged. */
  work(): Promise<unknown>;
}

export interface SellDeps {
  client: B402Client;
  payTo: string;
  /** Cached `/supported` kinds. */
  kinds(): Promise<B402Kind[]>;
  guard: NonceGuard;
  now(): number;
}

export type SellResult =
  | { status: 402; headers: Record<string, string>; body: { error: string; reason?: string; message?: string; paymentRequired: PaymentRequired } }
  | { status: 200; headers: Record<string, string>; body: unknown; settlement: { transaction: string | null; payer: string | null } }
  | { status: 500 | 502; headers: Record<string, string>; body: { error: string; message: string } };

/**
 * One x402 v2 sale through B402. No proof: 402 with the requirements. With a proof: strict decode,
 * `accepted` must deep-equal a requirement we issue, local replay guard, Verify, the work, Settle,
 * then 200 with `PAYMENT-RESPONSE`. Any refusal is a 402 that names the reason.
 */
export async function sellX402(opts: SellOptions, d: SellDeps): Promise<SellResult> {
  const accepts = buildRequirements(await d.kinds(), { amount: priceToAmount(opts.priceU), payTo: d.payTo });
  if (accepts.length === 0) {
    return { status: 502, headers: {}, body: { error: "b402_unavailable", message: "B402 offers no EIP-3009 kind for U or USD1 right now." } };
  }
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: opts.resource,
    accepts,
    ...(opts.bazaar ? { extensions: { bazaar: opts.bazaar } } : {}),
  };
  const refuse = (error: string, reason?: string, message?: string): SellResult => ({
    status: 402,
    headers: { "PAYMENT-REQUIRED": b64({ ...paymentRequired, error: reason ?? error }) },
    body: { error, ...(reason ? { reason } : {}), ...(message ? { message } : {}), paymentRequired },
  });

  if (!opts.proof) return refuse("payment_required");
  const payload = decodePaymentPayload(opts.proof);
  if (!payload) return refuse("invalid_payment", "invalid_payload", "PAYMENT-SIGNATURE is not a base64 x402 v2 EIP-3009 payment payload.");
  const requirement = accepts.find((a) => sameRequirement(a, payload.accepted));
  if (!requirement) return refuse("invalid_payment", "invalid_payment_requirements", "paymentPayload.accepted does not match a requirement this server issued.");
  const nonce = payload.payload.authorization.nonce;
  if (d.guard.has(nonce)) return refuse("invalid_payment", "nonce_already_used", "This authorization was already redeemed here.");

  let verified: B402Verify;
  try {
    verified = await d.client.verify(payload, requirement);
  } catch (err) {
    return { status: 502, headers: {}, body: { error: "b402_verify_failed", message: describeB402Error(err) } };
  }
  if (!verified.isValid) return refuse("payment_rejected", verified.invalidReason ?? "unexpected_verify_error", verified.invalidMessage ?? undefined);

  let result: unknown;
  try {
    result = await opts.work();
  } catch (err) {
    return { status: 500, headers: {}, body: { error: "work_failed", message: `${err instanceof Error ? err.message : String(err)} (not charged)` } };
  }

  const toSettle = opts.bazaar ? { ...payload, extensions: { ...payload.extensions, bazaar: opts.bazaar } } : payload;
  let settled: B402Settle;
  try {
    settled = await d.client.settle(toSettle, requirement);
  } catch (err) {
    return { status: 502, headers: {}, body: { error: "b402_settle_failed", message: describeB402Error(err) } };
  }
  const validBefore = Number(payload.payload.authorization.validBefore) * 1000;
  if (!settled.success) {
    // A broadcast transaction may still land; hold the nonce so the same proof cannot be retried here.
    if (settled.transaction) d.guard.add(nonce, Number.isFinite(validBefore) ? validBefore : d.now() + 600_000);
    return refuse("settlement_failed", settled.errorReason ?? "settle_failed", settled.errorMessage ?? settled.transaction ?? undefined);
  }
  d.guard.add(nonce, Number.isFinite(validBefore) ? Math.max(validBefore, d.now() + 60_000) : d.now() + 600_000);
  const response = { success: true, transaction: settled.transaction ?? null, network: settled.network ?? B402_NETWORK, payer: settled.payer ?? verified.payer ?? null };
  return {
    status: 200,
    headers: { "PAYMENT-RESPONSE": b64(response) },
    body: result,
    settlement: { transaction: response.transaction, payer: response.payer },
  };
}

/** `/supported` kinds cached for `ttlMs`; a failed refresh keeps serving the last good copy. */
export function cachedKinds(client: Pick<B402Client, "supported">, ttlMs = 600_000, now: () => number = Date.now): () => Promise<B402Kind[]> {
  let cache: { at: number; kinds: B402Kind[] } | null = null;
  let inflight: Promise<B402Kind[]> | null = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.kinds;
    inflight ??= client
      .supported()
      .then((s) => {
        cache = { at: now(), kinds: s.kinds };
        return s.kinds;
      })
      .catch((err) => {
        if (cache) return cache.kinds;
        throw err;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
