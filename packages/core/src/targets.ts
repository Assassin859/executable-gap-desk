import { isBawRejection } from "./baw";
import { createBawWallet, type BawWallet, type OrderInfo } from "./bawWallet";
import { USDT_BSC } from "./config";
import {
  Refusal,
  commonRails,
  finishRun,
  gateRow,
  listReceipts,
  newRun,
  pct,
  recordGate,
  requireGo,
  spentTodayUsd,
  venueContext,
  type ExecMode,
  type ExecResult,
  type GateResult,
  type VenueContext,
} from "./execute";
import { DEFAULT_POLICY, type Policy, type Verdict } from "./gate";
import { loadRegistry, resolve, type Venue } from "./registry";
import { usdQty } from "./marketOrder";

export interface TargetDeps {
  venue(symbol: string): Promise<VenueContext>;
  gateBuy(ctx: VenueContext, usd: number, wallet: string, policy: Policy): Promise<GateResult>;
  wallet: Pick<BawWallet, "quote" | "limitBuy" | "limitOrders" | "limitCancel">;
  registry(): Promise<Venue[]>;
  confirm(summary: string): Promise<boolean>;
  now(): number;
  log(step: string, detail?: string): void;
}

export function defaultTargetDeps(): TargetDeps {
  return {
    venue: venueContext,
    gateBuy: (ctx, usd, wallet, policy) => gateRow(ctx.row, ctx.session, usd, wallet, policy),
    wallet: createBawWallet(),
    registry: loadRegistry,
    confirm: async () => false,
    now: Date.now,
    log: () => {},
  };
}

const withDefaults = (d?: Partial<TargetDeps>): TargetDeps => {
  const keys: Array<keyof TargetDeps> = ["venue", "gateBuy", "wallet", "registry", "confirm", "now", "log"];
  return d && keys.every((k) => k in d) ? (d as TargetDeps) : { ...defaultTargetDeps(), ...d };
};

export const DEFAULT_DISCOUNT_PCT = 0.25;

/** Trigger in USD per token: the stock price per token, less the discount. Never above the stock. */
export function triggerPrice(reference: number, multiplier: number, discountPct: number): number {
  return reference * multiplier * (1 - discountPct / 100);
}

export interface TargetOptions {
  usd: number;
  /** Percent below the stock price per token, e.g. 0.25 for 0.25%. */
  discountPct?: number;
  live?: boolean;
  wallet?: string;
  policy?: Policy;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<TargetDeps>;
  receiptsDir?: string | null;
}

/**
 * A gap-guarded limit buy: only placed on a venue that is GO right now, with the trigger at or below
 * the stock price per token and below the wallet's current price (otherwise it would fill at once).
 */
export async function placeTarget(symbol: string, opts: TargetOptions): Promise<ExecResult> {
  const env = opts.env ?? process.env;
  const policy = opts.policy ?? DEFAULT_POLICY;
  const d = withDefaults(opts.deps);
  const wallet = opts.wallet ?? env.GAP_WALLET_ADDRESS ?? "";
  const mode: ExecMode = opts.live ? "live" : "dry-run";
  const dir = opts.receiptsDir === undefined ? null : opts.receiptsDir;
  const discount = opts.discountPct ?? DEFAULT_DISCOUNT_PCT;
  const run = newRun("limit", symbol, opts.usd, mode, wallet, d);
  const { r } = run;
  r.side = "buy";
  r.via = "market-order";
  try {
    commonRails(env, wallet);
    if (!(opts.usd > 0) || !Number.isFinite(opts.usd)) throw new Refusal("BAD_SIZE", `Size must be a positive USD amount, got ${opts.usd}.`);
    if (opts.usd > policy.maxLimitOrderUsd) throw new Refusal("SIZE_OVER_CAP", `$${opts.usd} is over the $${policy.maxLimitOrderUsd} limit-order cap.`);
    if (!(discount >= 0 && discount < 50)) throw new Refusal("BAD_SIZE", `Discount must be a percent from 0 to 50, got ${discount}.`);
    if (mode === "live") {
      const spent = spentTodayUsd(dir ? listReceipts(dir) : [], d.now());
      if (spent + opts.usd > policy.maxDailySpendUsd) {
        throw new Refusal("DAILY_CAP", `$${spent.toFixed(2)} already committed today; $${opts.usd} more would pass the $${policy.maxDailySpendUsd} daily cap.`);
      }
    }

    const ctx = await d.venue(symbol);
    r.venue = { ticker: ctx.ticker, platform: ctx.row.platform, address: ctx.row.address };
    run.step("gate", `${symbol} at $${opts.usd}`);
    const g = await d.gateBuy(ctx, opts.usd, wallet, policy);
    recordGate(r, g, d.now());
    const q = requireGo(g, policy, d.now());
    const ref = g.row.reference;
    if (!ref) throw new Refusal("GATE_NOT_GO", "No independent stock price, so there is nothing to set the trigger against.");
    run.step("gate passed", `GO, fill ${pct(g.verdict.executableGapPct ?? 0)} vs the stock`);

    const trigger = Math.floor(triggerPrice(ref, q.multiplier, discount) * 1e6) / 1e6;
    const qty = usdQty(opts.usd);
    const wq = await d.wallet.quote({ fromToken: USDT_BSC, toToken: ctx.row.address, qty, slippage: policy.slippagePct });
    const walletPx = Number(wq.fromCoinAmount) / Number(wq.toCoinAmount);
    r.limit = { triggerPriceUsd: trigger, discountPct: discount, qty, walletPricePerToken: Number.isFinite(walletPx) ? walletPx : null };
    if (!Number.isFinite(walletPx) || trigger >= walletPx) {
      throw new Refusal(
        "TRIGGER_AT_MARKET",
        `The trigger $${trigger.toFixed(4)} is at or above the wallet's price $${Number.isFinite(walletPx) ? walletPx.toFixed(4) : "?"} per token, so it would fill at once; use gap exec instead.`,
      );
    }
    run.step("trigger set", `$${trigger.toFixed(4)} per token (${discount}% under the stock at $${(ref * q.multiplier).toFixed(4)}/token; wallet price $${walletPx.toFixed(4)})`);

    if (mode === "dry-run") {
      r.outcome = "SIMULATED";
      run.step("dry run: limit order not placed", "pass --live to place it with the Agentic Wallet");
      return finishRun(run, dir);
    }
    const summary = `Place a limit buy of ${qty} USDT of ${symbol}, triggering at $${trigger.toFixed(4)} per token (${discount}% under the stock).`;
    if (!(await d.confirm(summary))) throw new Refusal("USER_DECLINED", "Declined at the confirmation prompt (limit order).");
    run.step("limit order: place");
    const o = await d.wallet.limitBuy({ triggerPriceUsd: trigger, fromToken: USDT_BSC, toToken: ctx.row.address, qty, slippage: policy.slippagePct }).catch((e: unknown) => {
      throw isBawRejection(e) ? new Refusal("WALLET_REJECTED", `The Agentic Wallet refused the limit order: ${e.message}`) : e;
    });
    r.order = { id: o.id, status: o.status, raw: o.raw };
    r.outcome = "PLACED";
    run.step("limit order: placed", `strategy ${o.id}`);
    return finishRun(run, dir);
  } catch (err) {
    return finishRun(run, dir, err);
  }
}

export interface TargetRow {
  order: OrderInfo;
  symbol: string | null;
  usd: number | null;
  triggerPriceUsd: number | null;
  verdict: Verdict | null;
  cancelSuggested: boolean;
  why: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/^\$/, "")) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Fields of a limit order in `limit-order list`, read by their likely names. */
export function limitOrderFields(o: OrderInfo) {
  const raw = o.raw;
  return {
    toToken: str(raw.toToken) ?? str(raw.toTokenAddress) ?? str(raw.toCoinAddress),
    usd: num(raw.fromTokenQty) ?? num(raw.fromCoinAmount) ?? num(raw.fromTokenAmount),
    triggerPriceUsd: num(raw.triggerPrice),
  };
}

/** Cancel is suggested when the venue is now BLOCK or its displayed and executable prices disagree. */
export function cancelSuggested(g: GateResult | null): { suggested: boolean; why: string | null } {
  if (!g) return { suggested: true, why: "the venue could not be re-gated" };
  const block = g.verdict.verdict === "BLOCK";
  const mismatch = g.verdict.reasons.find((r) => r.code === "DISPLAY_MISMATCH" || r.code === "SPREAD_AT_BASE");
  if (mismatch) return { suggested: true, why: mismatch.message };
  if (block) return { suggested: true, why: g.verdict.reasons.find((r) => r.severity === "block")?.message ?? "venue is BLOCK" };
  return { suggested: false, why: null };
}

/** WORKING limit orders, each re-gated at its order size. */
export async function listTargets(opts: { wallet?: string; policy?: Policy; env?: NodeJS.ProcessEnv; deps?: Partial<TargetDeps> } = {}): Promise<TargetRow[]> {
  const env = opts.env ?? process.env;
  const policy = opts.policy ?? DEFAULT_POLICY;
  const d = withDefaults(opts.deps);
  const wallet = opts.wallet ?? env.GAP_WALLET_ADDRESS ?? "";
  const orders = await d.wallet.limitOrders({ status: "WORKING" });
  const venues = orders.length ? await d.registry() : [];
  const rows: TargetRow[] = [];
  for (const order of orders) {
    const f = limitOrderFields(order);
    const v = f.toToken ? resolve(venues, f.toToken)?.match : undefined;
    let g: GateResult | null = null;
    if (v && f.usd) {
      g = await d
        .venue(v.symbol)
        .then((ctx) => d.gateBuy(ctx, f.usd!, wallet, policy))
        .catch(() => null);
    }
    const c = cancelSuggested(g);
    rows.push({ order, symbol: v?.symbol ?? null, usd: f.usd, triggerPriceUsd: f.triggerPriceUsd, verdict: g?.verdict.verdict ?? null, cancelSuggested: c.suggested, why: c.why });
  }
  return rows;
}

export interface CancelOptions {
  live?: boolean;
  wallet?: string;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<TargetDeps>;
  receiptsDir?: string | null;
}

export async function cancelTarget(strategyId: string, opts: CancelOptions = {}): Promise<ExecResult> {
  const env = opts.env ?? process.env;
  const d = withDefaults(opts.deps);
  const wallet = opts.wallet ?? env.GAP_WALLET_ADDRESS ?? "";
  const mode: ExecMode = opts.live ? "live" : "dry-run";
  const dir = opts.receiptsDir === undefined ? null : opts.receiptsDir;
  const run = newRun("limit", `cancel-${strategyId}`, 0, mode, wallet, d);
  const { r } = run;
  r.side = "buy";
  r.via = "market-order";
  try {
    commonRails(env, wallet);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(strategyId)) throw new Refusal("BAD_SIZE", `Invalid strategy id: ${strategyId}.`);
    const orders = await d.wallet.limitOrders({});
    const o = orders.find((x) => x.id === strategyId);
    if (o) {
      const f = limitOrderFields(o);
      r.order = { id: o.id, status: o.status, raw: o.raw };
      r.usd = f.usd ?? 0;
      const venues = f.toToken ? await d.registry() : [];
      const v = f.toToken ? resolve(venues, f.toToken)?.match : undefined;
      if (v) {
        r.symbol = v.symbol;
        r.venue = { ticker: v.ticker, platform: v.platform, address: v.address };
      }
      if (f.triggerPriceUsd) r.limit = { triggerPriceUsd: f.triggerPriceUsd, discountPct: 0, qty: String(f.usd ?? ""), walletPricePerToken: null };
    } else {
      r.order = { id: strategyId, status: "UNKNOWN", raw: null };
    }
    run.step("limit order found", o ? `${o.status}` : "not in the list; trying to cancel anyway");
    if (mode === "dry-run") {
      r.outcome = "SIMULATED";
      run.step("dry run: not cancelled", "pass --live to cancel it");
      return finishRun(run, dir);
    }
    if (!(await d.confirm(`Cancel limit order ${strategyId}${o ? ` (${o.status})` : ""}?`))) throw new Refusal("USER_DECLINED", "Declined at the confirmation prompt (cancel).");
    const res = await d.wallet.limitCancel(strategyId);
    r.order = { id: strategyId, status: "CANCELED", raw: { before: r.order?.raw ?? null, cancel: res } };
    r.outcome = "CANCELED";
    run.step("limit order: cancelled", strategyId);
    return finishRun(run, dir);
  } catch (err) {
    return finishRun(run, dir, err);
  }
}
