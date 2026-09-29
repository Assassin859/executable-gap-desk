import { z } from "zod";
import { BawError, createBawRunner, parseBawOutput, type BawRunner } from "./baw";
import { CHAIN_ID } from "./config";

const num = z.union([z.number(), z.string()]).transform((v) => Number(v));
const str = z.union([z.string(), z.number()]).transform((v) => String(v));

export const WalletTokenSchema = z.looseObject({
  symbol: z.string(),
  address: z.string(),
  binanceChainId: str.optional(),
  balance: z.string(),
  price: num.nullish(),
  value: num.nullish(),
});
export type WalletToken = z.infer<typeof WalletTokenSchema>;

export const QuotaSchema = z.looseObject({ quotaUsed: num, quotaLeft: num, dailyLimit: num, date: z.string().optional() });
export type Quota = z.infer<typeof QuotaSchema>;

export const MarketQuoteSchema = z.looseObject({
  fromCoinSymbol: z.string().nullish(),
  fromCoinAmount: z.string(),
  toCoinSymbol: z.string().nullish(),
  toCoinAmount: z.string(),
  slippage: num.nullish(),
});
export type MarketQuote = z.infer<typeof MarketQuoteSchema>;

const PageSchema = z.looseObject({ total: num.optional(), list: z.array(z.record(z.string(), z.unknown())).default([]) });

export type OrderStatus = "PENDING" | "FINISHED" | "FAILED" | "WORKING" | "TRIGGERED" | "EXPIRED" | "CANCELED" | "UNKNOWN";

export interface OrderInfo {
  id: string;
  status: OrderStatus;
  txHash: string | null;
  raw: Record<string, unknown>;
}

const STATUSES = new Set<OrderStatus>(["PENDING", "FINISHED", "FAILED", "WORKING", "TRIGGERED", "EXPIRED", "CANCELED"]);

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
}

/** Order objects differ between swap, list and limit responses; read the fields we need by their known aliases. */
export function toOrderInfo(o: Record<string, unknown>): OrderInfo {
  const id = pick(o, ["orderId", "strategyId", "id"]);
  const status = String(pick(o, ["status", "orderStatus", "state"]) ?? "UNKNOWN").toUpperCase() as OrderStatus;
  const tx = pick(o, ["txHash", "transactionHash", "hash", "txId"]);
  return { id: id === undefined ? "" : String(id), status: STATUSES.has(status) ? status : "UNKNOWN", txHash: typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx : null, raw: o };
}

async function runJson(run: BawRunner, args: string[]): Promise<unknown> {
  return parseBawOutput(await run([...args, "--json"]));
}

export function walletBalanceArgs(): string[] {
  return ["wallet", "balance", "--binanceChainId", CHAIN_ID];
}

export async function walletBalance(run: BawRunner = createBawRunner()): Promise<WalletToken[]> {
  return z.array(WalletTokenSchema).parse(await runJson(run, walletBalanceArgs()));
}

export async function leftQuota(run: BawRunner = createBawRunner()): Promise<Quota> {
  return QuotaSchema.parse(await runJson(run, ["wallet", "left-quota"]));
}

export interface MarketParams {
  fromToken: string;
  toToken: string;
  /** Decimal string in from-token units (never a float). */
  qty: string;
  /** Percent 0-100, or "auto". */
  slippage?: number | "auto";
}

const assertQty = (qty: string) => {
  if (!/^\d+(\.\d+)?$/.test(qty) || Number(qty) <= 0) throw new BawError(`Invalid token quantity: ${qty}`);
};

export function marketQuoteArgs(p: MarketParams): string[] {
  assertQty(p.qty);
  const args = ["market-order", "quote", "--binanceChainId", CHAIN_ID, "--fromTokenQty", p.qty, "--fromToken", p.fromToken, "--toToken", p.toToken];
  if (p.slippage !== undefined) args.push("--slippage", String(p.slippage));
  return args;
}

export async function marketQuote(p: MarketParams, run: BawRunner = createBawRunner()): Promise<MarketQuote> {
  return MarketQuoteSchema.parse(await runJson(run, marketQuoteArgs(p)));
}

export interface SwapOptions extends MarketParams {
  mev?: boolean;
  gasLevel?: "LOW" | "MEDIUM" | "HIGH";
}

export function marketSwapArgs(p: SwapOptions): string[] {
  assertQty(p.qty);
  return [
    "market-order", "swap", "--binanceChainId", CHAIN_ID,
    "--fromTokenQty", p.qty, "--fromToken", p.fromToken, "--toToken", p.toToken,
    "--slippage", String(p.slippage ?? "auto"), "--mev", String(p.mev ?? true), "--gasLevel", p.gasLevel ?? "MEDIUM",
  ];
}

/** Executes immediately: `baw market-order swap` has no preview step. Callers gate and confirm first. */
export async function marketSwap(p: SwapOptions, run: BawRunner = createBawRunner()): Promise<OrderInfo> {
  const data = await runJson(run, marketSwapArgs(p));
  const info = toOrderInfo(z.record(z.string(), z.unknown()).parse(data));
  if (!info.id) throw new BawError("market-order swap returned no order id", data);
  return info;
}

export async function marketOrder(orderId: string, run: BawRunner = createBawRunner()): Promise<OrderInfo | null> {
  const page = PageSchema.parse(await runJson(run, ["market-order", "list", "--orderId", orderId]));
  const hit = page.list.map(toOrderInfo).find((o) => o.id === orderId) ?? (page.list[0] ? toOrderInfo(page.list[0]) : null);
  return hit;
}

export interface FindOrderParams {
  fromToken: string;
  toToken: string;
  qty: string;
  sinceMs: number;
}

const sameQty = (a: unknown, b: string) => typeof a === "string" && a.replace(/\.?0+$/, "") === b.replace(/\.?0+$/, "");

/**
 * The order id printed by `market-order swap` is not always the id `market-order list` stores
 * (live: swap said ...301, the list holds ...302), so orders are also found by pair, quantity and time.
 */
export async function findMarketOrder(p: FindOrderParams, run: BawRunner = createBawRunner()): Promise<OrderInfo | null> {
  const args = ["market-order", "list", "--binanceChainId", CHAIN_ID, "--fromToken", p.fromToken, "--toToken", p.toToken, "--startTime", String(p.sinceMs - 120_000), "--pageSize", "20"];
  const page = PageSchema.parse(await runJson(run, args));
  const hits = page.list
    .filter((o) => sameQty(o.fromTokenQty, p.qty))
    .filter((o) => {
      const t = Date.parse(String(o.bookTime ?? ""));
      return Number.isNaN(t) || t >= p.sinceMs - 120_000;
    })
    .sort((a, b) => Date.parse(String(b.bookTime ?? 0)) - Date.parse(String(a.bookTime ?? 0)));
  return hits[0] ? toOrderInfo(hits[0]) : null;
}

export interface LimitBuyParams {
  triggerPriceUsd: number;
  fromToken: string;
  toToken: string;
  qty: string;
  slippage?: number | "auto";
}

export function limitBuyArgs(p: LimitBuyParams): string[] {
  assertQty(p.qty);
  if (!(p.triggerPriceUsd > 0)) throw new BawError(`Invalid trigger price: ${p.triggerPriceUsd}`);
  return [
    "limit-order", "buy", "--binanceChainId", CHAIN_ID,
    "--triggerPrice", p.triggerPriceUsd.toFixed(6).replace(/\.?0+$/, ""),
    "--fromTokenQty", p.qty, "--fromToken", p.fromToken, "--toToken", p.toToken,
    "--slippage", String(p.slippage ?? "auto"),
  ];
}

export async function limitBuy(p: LimitBuyParams, run: BawRunner = createBawRunner()): Promise<OrderInfo> {
  const data = await runJson(run, limitBuyArgs(p));
  const info = toOrderInfo(z.record(z.string(), z.unknown()).parse(typeof data === "object" && data ? data : { strategyId: data }));
  if (!info.id) throw new BawError("limit-order buy returned no strategy id", data);
  return info;
}

export async function limitOrders(opts: { status?: OrderStatus } = {}, run: BawRunner = createBawRunner()): Promise<OrderInfo[]> {
  const args = ["limit-order", "list", "--binanceChainId", CHAIN_ID, "--pageSize", "100"];
  if (opts.status) args.push("--status", opts.status);
  return PageSchema.parse(await runJson(run, args)).list.map(toOrderInfo);
}

export async function limitCancel(strategyId: string, run: BawRunner = createBawRunner()): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(strategyId)) throw new BawError(`Invalid strategy id: ${strategyId}`);
  return runJson(run, ["limit-order", "cancel", "--strategyId", strategyId]);
}

// ---------- x402 (B402) payments ----------

export const X402OptionSchema = z.looseObject({
  index: num,
  status: z.string(),
  reasons: z.array(z.string()).default([]),
  scheme: z.string().nullish(),
  assetTransferMethod: z.string().nullish(),
  tokenAddress: z.string(),
  tokenSymbol: z.string().nullish(),
  amount: z.string(),
  amountUsd: num.nullish(),
  payTo: z.string().nullish(),
  currentBalance: z.string().nullish(),
  needApproveFirst: z.boolean().nullish(),
  originalAccept: z.record(z.string(), z.unknown()),
});
export type X402Option = z.infer<typeof X402OptionSchema>;

export const X402PreviewSchema = z.looseObject({ paymentId: z.string().min(1), options: z.array(X402OptionSchema) });
export type X402Preview = z.infer<typeof X402PreviewSchema>;

export const X402SignSchema = z.looseObject({
  paymentHeaderName: z.string().min(1),
  paymentHeaderValue: z.string().min(1),
  signatureExpiresAt: num.nullish(),
  /** Set when signing a Permit2 option made baw dispatch an approval transaction first. */
  approveTxHash: z.string().nullish(),
  binanceChainId: str.nullish(),
});
export type X402Signed = z.infer<typeof X402SignSchema>;

/** `requirements` is the server's `PAYMENT-REQUIRED` header value (base64) or the raw JSON; baw auto-detects. */
export function x402PreviewArgs(requirements: string): string[] {
  if (!requirements.trim()) throw new BawError("Empty x402 payment requirements");
  return ["x402-payment", "preview", "--paymentRequirements", requirements.trim()];
}

export async function x402Preview(requirements: string, run: BawRunner = createBawRunner()): Promise<X402Preview> {
  return X402PreviewSchema.parse(await runJson(run, x402PreviewArgs(requirements)));
}

export function x402SignArgs(paymentId: string, index: number): string[] {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(paymentId)) throw new BawError(`Invalid x402 payment id: ${paymentId}`);
  if (!Number.isInteger(index) || index < 0) throw new BawError(`Invalid x402 option index: ${index}`);
  return ["x402-payment", "sign", "--paymentId", paymentId, "--selectedIndex", String(index)];
}

export async function x402Sign(paymentId: string, index: number, run: BawRunner = createBawRunner()): Promise<X402Signed> {
  return X402SignSchema.parse(await runJson(run, x402SignArgs(paymentId, index)));
}

export interface BawWallet {
  balance(): Promise<WalletToken[]>;
  quota(): Promise<Quota>;
  quote(p: MarketParams): Promise<MarketQuote>;
  swap(p: SwapOptions): Promise<OrderInfo>;
  order(orderId: string): Promise<OrderInfo | null>;
  findOrder(p: FindOrderParams): Promise<OrderInfo | null>;
  limitBuy(p: LimitBuyParams): Promise<OrderInfo>;
  limitOrders(opts?: { status?: OrderStatus }): Promise<OrderInfo[]>;
  limitCancel(strategyId: string): Promise<unknown>;
  x402Preview(requirements: string): Promise<X402Preview>;
  x402Sign(paymentId: string, index: number): Promise<X402Signed>;
}

export function createBawWallet(run: BawRunner = createBawRunner()): BawWallet {
  return {
    balance: () => walletBalance(run),
    quota: () => leftQuota(run),
    quote: (p) => marketQuote(p, run),
    swap: (p) => marketSwap(p, run),
    order: (id) => marketOrder(id, run),
    findOrder: (p) => findMarketOrder(p, run),
    limitBuy: (p) => limitBuy(p, run),
    limitOrders: (o) => limitOrders(o, run),
    limitCancel: (id) => limitCancel(id, run),
    x402Preview: (req) => x402Preview(req, run),
    x402Sign: (id, i) => x402Sign(id, i, run),
  };
}
