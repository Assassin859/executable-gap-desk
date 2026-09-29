import { formatUnits, parseUnits } from "viem";
import { isBawRejection } from "./baw";
import { createBawWallet, type BawWallet, type FindOrderParams, type OrderInfo } from "./bawWallet";
import { bscTxUrl, createChainReader, transferSum, type ChainReader } from "./chain";
import { USDT_BSC } from "./config";
import {
  GAS_RESERVE_WEI,
  Refusal,
  commonRails,
  finishRun,
  gateRow,
  gateSellRow,
  listReceipts,
  newRun,
  pct,
  recordGate,
  requireGo,
  spentTodayUsd,
  units,
  venueContext,
  writeReceipt,
  type ExecMode,
  type ExecReceipt,
  type ExecResult,
  type GateResult,
  type Run,
  type VenueContext,
} from "./execute";
import { DEFAULT_POLICY, type Policy } from "./gate";
import type { QuoteOk, Side } from "./quotes";
import { NATIVE_BNB } from "./trade";

export interface MarketDeps {
  venue(symbol: string): Promise<VenueContext>;
  gateBuy(ctx: VenueContext, usd: number, wallet: string, policy: Policy): Promise<GateResult>;
  gateSell(ctx: VenueContext, qty: bigint, decimals: number, wallet: string, policy: Policy): Promise<GateResult>;
  chain: ChainReader;
  wallet: Pick<BawWallet, "quote" | "swap" | "order"> & Partial<Pick<BawWallet, "findOrder">>;
  confirm(summary: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(step: string, detail?: string): void;
}

export function defaultMarketDeps(): MarketDeps {
  return {
    venue: venueContext,
    gateBuy: (ctx, usd, wallet, policy) => gateRow(ctx.row, ctx.session, usd, wallet, policy),
    gateSell: gateSellRow,
    chain: createChainReader(),
    wallet: createBawWallet(),
    confirm: async () => false,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
  };
}

export interface MarketOrderOptions {
  side: Side;
  /** Buy: USDT to spend. Sell: USD value to sell, converted to tokens at the displayed price. */
  usd?: number;
  /** Sell only: exact token quantity as a decimal string. */
  qty?: string;
  /** Sell only: the whole on-chain balance. */
  all?: boolean;
  live?: boolean;
  wallet?: string;
  policy?: Policy;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<MarketDeps>;
  receiptsDir?: string | null;
}

export const ORDER_POLL_MS = 3_000;

const trimDecimal = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
export const usdQty = (usd: number) => trimDecimal(usd.toFixed(6));

/** Price per underlying share implied by a wallet quote, in the same direction as the aggregator quote. */
export function walletFillPerShare(side: Side, fromQty: string, toQty: string, multiplier: number): number {
  const from = Number(fromQty);
  const to = Number(toQty);
  return side === "sell" ? to / (from * multiplier) : from / (to * multiplier);
}

function resolveDeps(injected?: Partial<MarketDeps>): MarketDeps {
  const keys: Array<keyof MarketDeps> = ["venue", "gateBuy", "gateSell", "chain", "wallet", "confirm", "now", "sleep", "log"];
  if (injected && keys.every((k) => k in injected)) return injected as MarketDeps;
  return { ...defaultMarketDeps(), ...injected };
}

async function sizeSell(run: Run<MarketDeps>, ctx: VenueContext, opts: MarketOrderOptions, wallet: string, mode: ExecMode) {
  const { d, r } = run;
  const token = ctx.row.address;
  const decimals = (await d.chain.decimals?.(token)) ?? 18;
  const held = await d.chain.balance(token, wallet);
  r.balances = { ...(r.balances ?? { usdt: "0", bnb: "0", allowance: "0" }), token: held.toString() };
  const picks = [opts.all ? 1 : 0, opts.qty !== undefined ? 1 : 0, opts.usd !== undefined ? 1 : 0].reduce((a, b) => a + b, 0);
  if (picks !== 1) throw new Refusal("BAD_SIZE", "A sell needs exactly one of --all, --qty or --usd.");
  let qty: bigint;
  if (opts.all) {
    if (held === 0n) throw new Refusal("NO_POSITION", `The wallet holds no ${ctx.row.symbol}.`);
    qty = held;
  } else if (opts.qty !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(opts.qty)) throw new Refusal("BAD_SIZE", `Token quantity must be a plain decimal, got ${opts.qty}.`);
    qty = parseUnits(opts.qty, decimals);
  } else {
    const usd = opts.usd!;
    if (!(usd > 0) || !Number.isFinite(usd)) throw new Refusal("BAD_SIZE", `Size must be a positive USD amount, got ${usd}.`);
    const px = ctx.row.tokenPrice;
    if (!px || px <= 0) throw new Refusal("BAD_SIZE", `No displayed ${ctx.row.symbol} price to size a USD sell by; use --qty or --all.`);
    qty = parseUnits((usd / px).toFixed(Math.min(decimals, 12)), decimals);
  }
  if (qty <= 0n) throw new Refusal("BAD_SIZE", "The sell quantity rounds to zero.");
  if (held === 0n && mode === "live") throw new Refusal("NO_POSITION", `The wallet holds no ${ctx.row.symbol}.`);
  if (mode === "live" && qty > held) {
    throw new Refusal("INSUFFICIENT_BALANCE", `Wallet holds ${formatUnits(held, decimals)} ${ctx.row.symbol}; the sell needs ${formatUnits(qty, decimals)}.`);
  }
  return { qty, decimals, held };
}

/** Looks the order up by the id `swap` printed, then by pair, quantity and time (the ids can differ). */
async function lookupOrder(d: Pick<MarketDeps, "wallet">, id: string, find: FindOrderParams): Promise<OrderInfo | null> {
  const byId = await d.wallet.order(id).catch(() => null);
  if (byId) return byId;
  return d.wallet.findOrder ? d.wallet.findOrder(find).catch(() => null) : null;
}

const recordOrder = (r: ExecReceipt, o: OrderInfo, swapId: string) => {
  r.order = { id: o.id, status: o.status, raw: o.id === swapId ? o.raw : { ...o.raw, swapResponseOrderId: swapId } };
};

async function pollOrder(run: Run<MarketDeps>, first: OrderInfo, find: FindOrderParams, policy: Policy): Promise<OrderInfo> {
  const { d, r } = run;
  let o = first;
  const deadline = d.now() + policy.marketOrderTimeoutSec * 1000;
  while (o.status !== "FINISHED" && o.status !== "FAILED") {
    if (d.now() >= deadline) {
      throw new Refusal("ORDER_TIMEOUT", `Order ${o.id} is still ${o.status} after ${policy.marketOrderTimeoutSec}s; settle it later with gap reconcile.`);
    }
    await d.sleep(ORDER_POLL_MS);
    const next = await lookupOrder(d, first.id, find);
    if (next) {
      o = { ...next, txHash: next.txHash ?? o.txHash };
      recordOrder(r, o, first.id);
    }
  }
  if (o.status === "FAILED") throw new Refusal("ORDER_FAILED", `The Agentic Wallet reports order ${o.id} FAILED: ${JSON.stringify(o.raw).slice(0, 300)}.`);
  return o;
}

interface FillContext {
  side: Side;
  token: string;
  wallet: string;
  tokenDecimals: number;
  multiplier: number;
  quotedFillPerShare: number | null;
  reference: number | null;
  slippagePct: number | null;
}

/** Reads the real fill of a finished order from its transaction's Transfer logs into the receipt. */
async function fillFromTx(r: ExecReceipt, chain: ChainReader, txHash: string, f: FillContext) {
  const receipt = await chain.waitForReceipt(txHash);
  r.swap = {
    to: receipt.to ?? "",
    value: "0",
    txHash,
    bscscan: bscTxUrl(txHash),
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    gasCostBnb: units(receipt.gasUsed * receipt.effectiveGasPrice),
    minReceiveAmount: null,
    slippagePct: f.slippagePct,
    gas: null,
    gasPrice: null,
    worstCaseGapPct: null,
  };
  if (receipt.status !== "success") throw new Refusal("TX_REVERTED", `The market order transaction reverted on-chain (${txHash}).`);
  const [got, paid] =
    f.side === "sell"
      ? [transferSum(receipt.logs, f.token, f.wallet, "from"), transferSum(receipt.logs, USDT_BSC, f.wallet, "to")]
      : [transferSum(receipt.logs, f.token, f.wallet, "to"), transferSum(receipt.logs, USDT_BSC, f.wallet, "from")];
  setFill(r, got, paid, "transfer-logs", f);
}

function setFill(r: ExecReceipt, tokensRaw: bigint, usdtRaw: bigint, source: "transfer-logs" | "balance-change", f: FillContext) {
  const tokens = units(tokensRaw, f.tokenDecimals);
  const usdAmt = units(usdtRaw);
  const fill = tokens > 0 ? usdAmt / (tokens * f.multiplier) : null;
  r.fill = {
    tokensOut: tokens,
    usdSpent: f.side === "sell" ? 0 : usdAmt,
    ...(f.side === "sell" ? { usdReceived: usdAmt } : {}),
    source,
    fillPerShare: fill,
    quotedFillPerShare: f.quotedFillPerShare,
    realizedVsQuotedPct: fill && f.quotedFillPerShare ? fill / f.quotedFillPerShare - 1 : null,
    realizedGapPct: fill && f.reference ? (fill - f.reference) / f.reference : null,
  };
  if (f.side === "sell") r.usd = Math.round(usdAmt * 1e6) / 1e6;
  r.outcome = "FILLED";
}

/**
 * A gated Agentic Wallet market order (`baw market-order swap`). Buys and sells both need a fresh GO,
 * and the wallet's own quote must agree with the gated quote before anything is sent. `swap` executes
 * immediately (it has no preview), so the typed confirmation is the last stop. Every path writes a receipt.
 */
export async function executeMarketOrder(symbol: string, opts: MarketOrderOptions): Promise<ExecResult> {
  const env = opts.env ?? process.env;
  const policy = opts.policy ?? DEFAULT_POLICY;
  const d = resolveDeps(opts.deps);
  const wallet = opts.wallet ?? env.GAP_WALLET_ADDRESS ?? "";
  const mode: ExecMode = opts.live ? "live" : "dry-run";
  const dir = opts.receiptsDir === undefined ? null : opts.receiptsDir;
  const side = opts.side;
  const run = newRun("trade", symbol, opts.usd ?? 0, mode, wallet, d);
  const { r } = run;
  r.side = side;
  r.via = "market-order";
  try {
    commonRails(env, wallet);
    if (side === "buy") {
      if (opts.qty !== undefined || opts.all) throw new Refusal("BAD_SIZE", "A buy is sized in USDT with --usd; --qty and --all are for sells.");
      const usd = opts.usd ?? NaN;
      if (!(usd > 0) || !Number.isFinite(usd)) throw new Refusal("BAD_SIZE", `Size must be a positive USD amount, got ${opts.usd}.`);
      if (usd > policy.maxTradeUsd) throw new Refusal("SIZE_OVER_CAP", `$${usd} is over the $${policy.maxTradeUsd} per-trade cap.`);
      if (mode === "live") {
        const spent = spentTodayUsd(dir ? listReceipts(dir) : [], d.now());
        if (spent + usd > policy.maxDailySpendUsd) {
          throw new Refusal("DAILY_CAP", `$${spent.toFixed(2)} already spent today; $${usd} more would pass the $${policy.maxDailySpendUsd} daily cap.`);
        }
      }
    }

    const ctx = await d.venue(symbol);
    r.venue = { ticker: ctx.ticker, platform: ctx.row.platform, address: ctx.row.address };
    const token = ctx.row.address;

    let g: GateResult;
    let fromQty: string;
    let decimals = 18;
    if (side === "sell") {
      const s = await sizeSell(run, ctx, opts, wallet, mode);
      decimals = s.decimals;
      fromQty = trimDecimal(formatUnits(s.qty, s.decimals));
      run.step("gate", `sell ${fromQty} ${symbol}`);
      g = await d.gateSell(ctx, s.qty, s.decimals, wallet, policy);
    } else {
      fromQty = usdQty(opts.usd!);
      run.step("gate", `${symbol} at $${opts.usd}`);
      g = await d.gateBuy(ctx, opts.usd!, wallet, policy);
    }
    recordGate(r, g, d.now());
    if (side === "sell" && g.quote?.ok) {
      r.usd = Math.round(g.quote.usd * 1e6) / 1e6;
      if (g.quote.usd > policy.maxTradeUsd) throw new Refusal("SIZE_OVER_CAP", `Selling ${fromQty} ${symbol} is worth $${g.quote.usd.toFixed(2)}, over the $${policy.maxTradeUsd} per-trade cap.`);
    }
    const q: QuoteOk = requireGo(g, policy, d.now());
    run.step("gate passed", `GO, ${side === "sell" ? "receive" : "fill"} ${pct(g.verdict.executableGapPct ?? 0)} vs the stock`);

    const [fromToken, toToken] = side === "sell" ? [token, USDT_BSC] : [USDT_BSC, token];
    const wq = await d.wallet.quote({ fromToken, toToken, qty: fromQty, slippage: policy.slippagePct });
    const wFill = walletFillPerShare(side, wq.fromCoinAmount, wq.toCoinAmount, q.multiplier);
    const deviation = wFill / q.fillPerShare - 1;
    const ref = g.row.reference;
    const wGap = ref ? (wFill - ref) / ref : null;
    r.walletQuote = { fromQty: wq.fromCoinAmount, toQty: wq.toCoinAmount, fillPerShare: wFill, deviationPct: deviation, gapPct: wGap };
    if (!Number.isFinite(wFill) || Math.abs(deviation) > policy.maxWalletQuoteDeviationPct) {
      throw new Refusal(
        "WALLET_QUOTE_MISMATCH",
        `The wallet quotes $${wFill.toFixed(2)}/share vs the gated $${q.fillPerShare.toFixed(2)} (${pct(deviation)}); the limit is ±${(policy.maxWalletQuoteDeviationPct * 100).toFixed(2)}%.`,
      );
    }
    if (wGap !== null && Math.abs(wGap) > policy.cautionMaxGapPct) {
      throw new Refusal("WALLET_QUOTE_MISMATCH", `The wallet's price is ${pct(wGap)} vs the stock; the limit is ±${(policy.cautionMaxGapPct * 100).toFixed(2)}%.`);
    }
    run.step("wallet quote checked", `$${wFill.toFixed(2)}/share (${pct(deviation)} vs the gated quote)`);

    const [usdt, bnb] = await Promise.all([d.chain.balance(USDT_BSC, wallet), d.chain.balance(NATIVE_BNB, wallet)]);
    const tokenBefore = side === "sell" ? BigInt(r.balances?.token ?? "0") : await d.chain.balance(token, wallet);
    r.balances = { usdt: usdt.toString(), bnb: bnb.toString(), allowance: "0", token: tokenBefore.toString() };
    if (mode === "live") {
      if (side === "buy" && usdt < parseUnits(fromQty, 18)) throw new Refusal("INSUFFICIENT_BALANCE", `Wallet holds ${units(usdt).toFixed(4)} USDT; the buy needs ${fromQty}.`);
      if (bnb < GAS_RESERVE_WEI) throw new Refusal("INSUFFICIENT_GAS", `Wallet holds ${units(bnb)} BNB; market orders need at least ${units(GAS_RESERVE_WEI)} BNB for gas.`);
    }

    if (mode === "dry-run") {
      r.outcome = "SIMULATED";
      run.step("dry run: wallet quote checked; not sent", "pass --live to send the market order");
      return finishRun(run, dir);
    }

    const expect =
      side === "sell"
        ? `Sell ${fromQty} ${symbol} for about ${Number(wq.toCoinAmount).toFixed(4)} USDT`
        : `Buy about ${Number(wq.toCoinAmount).toPrecision(6)} ${symbol} with ${fromQty} USDT`;
    const summary = `${expect} at $${wFill.toFixed(2)}/share (${pct(wGap ?? 0)} vs the stock) through an Agentic Wallet market order. It executes immediately.`;
    if (!(await d.confirm(summary))) throw new Refusal("USER_DECLINED", "Declined at the confirmation prompt (market order).");
    const age = (d.now() - q.ts) / 1000;
    if (age > policy.quoteMaxAgeSec) throw new Refusal("QUOTE_STALE", `The gated quote is ${Math.round(age)}s old after confirmation; the limit is ${policy.quoteMaxAgeSec}s. Run it again.`);

    run.step("market order: send");
    const sentAt = d.now();
    const placed = await d.wallet.swap({ fromToken, toToken, qty: fromQty, slippage: policy.slippagePct }).catch((e: unknown) => {
      throw isBawRejection(e) ? new Refusal("WALLET_REJECTED", `The Agentic Wallet refused the market order: ${e.message}`) : e;
    });
    run.broadcast = true;
    r.order = { id: placed.id, status: placed.status, raw: placed.raw };
    run.step("market order: accepted", `order ${placed.id} ${placed.status}`);
    const done = await pollOrder(run, placed, { fromToken, toToken, qty: fromQty, sinceMs: sentAt }, policy);
    run.step("market order: finished", done.txHash ?? "no tx hash in the order");

    const f: FillContext = {
      side,
      token,
      wallet,
      tokenDecimals: side === "sell" ? decimals : q.tokenDecimals,
      multiplier: q.multiplier,
      quotedFillPerShare: q.fillPerShare,
      reference: ref,
      slippagePct: policy.slippagePct,
    };
    if (done.txHash) await fillFromTx(r, d.chain, done.txHash, f);
    else {
      const [tokenAfter, usdtAfter] = await Promise.all([d.chain.balance(token, wallet), d.chain.balance(USDT_BSC, wallet)]);
      const [got, paid] = side === "sell" ? [tokenBefore - tokenAfter, usdtAfter - usdt] : [tokenAfter - tokenBefore, usdt - usdtAfter];
      setFill(r, got, paid, "balance-change", f);
    }
    run.step("filled", fillText(r));
    return finishRun(run, dir);
  } catch (err) {
    return finishRun(run, dir, err);
  }
}

const fillText = (r: ExecReceipt) => {
  const f = r.fill!;
  return r.side === "sell"
    ? `sold ${f.tokensOut.toPrecision(6)} ${r.symbol} for ${(f.usdReceived ?? 0).toFixed(4)} USDT`
    : `${f.tokensOut.toPrecision(6)} ${r.symbol} for ${f.usdSpent.toFixed(4)} USDT`;
};

export interface ReconcileOptions {
  deps?: Partial<Pick<MarketDeps, "venue" | "chain" | "wallet" | "now" | "log">>;
  receiptsDir?: string | null;
}

/**
 * Settles a PENDING market-order receipt (for example after ORDER_TIMEOUT): finds the order, and if it
 * FINISHED reads the real fill from its transaction. The original refusal stays in the steps.
 */
export async function reconcileMarketOrder(receipt: ExecReceipt, opts: ReconcileOptions = {}): Promise<ExecResult> {
  const d = { ...(opts.deps && ["venue", "chain", "wallet", "now", "log"].every((k) => k in opts.deps!) ? {} : defaultMarketDeps()), ...opts.deps } as MarketDeps;
  const dir = opts.receiptsDir === undefined ? null : opts.receiptsDir;
  const r: ExecReceipt = structuredClone(receipt);
  const step = (s: string, detail?: string) => {
    r.steps.push({ at: new Date(d.now()).toISOString(), step: s, ...(detail ? { detail } : {}) });
    d.log(s, detail);
  };
  const done = (): ExecResult => ({ receipt: r, path: dir ? writeReceipt(dir, r) : null });
  if (r.via !== "market-order" || r.kind !== "trade" || r.outcome !== "PENDING" || !r.order || !r.venue || !r.walletQuote) {
    throw new Error(`Receipt ${r.id} is not a PENDING market order.`);
  }
  const side: Side = r.side ?? "buy";
  const token = r.venue.address;
  const [fromToken, toToken] = side === "sell" ? [token, USDT_BSC] : [USDT_BSC, token];
  const swapId = String((r.order.raw as { swapResponseOrderId?: unknown } | null)?.swapResponseOrderId ?? r.order.id);
  const o = await lookupOrder(d, swapId, { fromToken, toToken, qty: r.walletQuote.fromQty, sinceMs: Date.parse(r.createdAt) });
  if (!o) {
    step("reconcile", "order not found yet");
    return done();
  }
  recordOrder(r, o, swapId);
  if (o.status === "FAILED") {
    r.outcome = "FAILED";
    r.refusal = { code: "ORDER_FAILED", message: `The Agentic Wallet reports order ${o.id} FAILED.` };
    step("reconciled", `order ${o.id} FAILED`);
    return done();
  }
  if (o.status !== "FINISHED" || !o.txHash) {
    step("reconcile", `order ${o.id} is ${o.status}`);
    return done();
  }
  const ctx = await d.venue(r.symbol);
  const multiplier = ctx.row.multiplier ?? 1;
  const decimals = (await d.chain.decimals?.(token)) ?? 18;
  const prev = r.refusal;
  await fillFromTx(r, d.chain, o.txHash, {
    side,
    token,
    wallet: r.wallet,
    tokenDecimals: decimals,
    multiplier,
    quotedFillPerShare: r.quote?.fillPerShare ?? null,
    reference: r.gate?.reference ?? null,
    slippagePct: r.swap?.slippagePct ?? null,
  });
  r.refusal = null;
  step("reconciled", `${prev ? `${prev.code} earlier; ` : ""}order ${o.id} FINISHED in ${o.txHash}`);
  step("filled", fillText(r));
  return done();
}
