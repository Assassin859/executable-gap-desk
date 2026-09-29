import { USDT_BSC, CHAIN_ID } from "./config";
import { ApiError, quoteLimiter, type Limiter } from "./http";
import type { Venue } from "./registry";
import { QuoteResponseSchema, type QuoteRoute } from "./schemas";
import { credentialsFromEnv, signedGet, type Credentials } from "./signer";

export const QUOTE_PATH = "/api/v1/dex/aggregator/quote";
export const USDT_DECIMALS = 18;
export const DEFAULT_LADDER = [25, 100, 500] as const;

export type QuoteReason =
  | "NO_LIQUIDITY"
  | "ONDO_MARKET_CLOSED"
  | "BSTOCK_MARKET_CLOSED"
  | "BELOW_MIN_ORDER"
  | "OVER_MAX_ORDER"
  | "BAD_PAIR"
  | "ZERO_OUTPUT"
  | "UNKNOWN_ERROR";

export const QUOTE_REASON_BY_CODE: Readonly<Record<string, QuoteReason>> = {
  "40374": "NO_LIQUIDITY",
  "40367": "ONDO_MARKET_CLOSED",
  "40369": "BSTOCK_MARKET_CLOSED",
  "40375": "BELOW_MIN_ORDER",
  "40366": "OVER_MAX_ORDER",
  "40368": "BAD_PAIR",
  "40370": "BAD_PAIR",
};

export const QUOTE_REASON_TEXT: Readonly<Record<QuoteReason, string>> = {
  NO_LIQUIDITY: "no liquidity from any vendor",
  ONDO_MARKET_CLOSED: "Ondo market closed for the underlying stock",
  BSTOCK_MARKET_CLOSED: "bStocks outside exchange trading hours",
  BELOW_MIN_ORDER: "order below the venue minimum",
  OVER_MAX_ORDER: "order above the market maker's single-order limit",
  BAD_PAIR: "counter token not allowed for this venue",
  ZERO_OUTPUT: "quote returned no tokens",
  UNKNOWN_ERROR: "quote failed",
};

interface QuoteBase {
  symbol: string;
  address: string;
  usd: number;
  ts: number;
  source: "binance-aggregator";
}

export interface QuoteOk extends QuoteBase {
  ok: true;
  tokensOut: number;
  multiplier: number;
  /** USDT paid per token and per underlying share (token / multiplier). */
  fillPerToken: number;
  fillPerShare: number;
  reference: number | null;
  executableGapPct: number | null;
  executionMode: string | null;
  vendorName: string | null;
  /** Token symbols along the route, e.g. USDT > USD1 > WBNB > NVDAB. */
  route: string[];
  protocols: string[];
  /**
   * API `priceImpactPercent`: despite the name, a 0-1 fraction against the market price
   * (live values reach 0.9995 on thin Uniswap V4 routes). Informational; the gate prices fills directly.
   */
  vendorPriceImpact: number | null;
  /** API `tradeFee`: tracks gas limit x gas price in USD (~$0.02 at any size), so it is the network fee, not a trading fee. */
  networkFeeUsd: number | null;
  /** API `estimateGasFee`: a gas limit in units (e.g. 450000), not a fee. */
  gasLimit: number | null;
  quoteId: string | null;
  routeCount: number;
}

export interface QuoteFail extends QuoteBase {
  ok: false;
  reason: QuoteReason;
  code: string | number | null;
  message: string;
}

export type ExecQuote = QuoteOk | QuoteFail;

/** Exact integer amount for a USD size in token base units; sizes are kept to 6 decimal places. */
export function usdToBaseUnits(usd: number, decimals: number = USDT_DECIMALS): string {
  const micro = BigInt(Math.round(usd * 1e6));
  return decimals >= 6 ? (micro * 10n ** BigInt(decimals - 6)).toString() : (micro / 10n ** BigInt(6 - decimals)).toString();
}

export function quotePath(toTokenAddress: string, usd: number, wallet?: string): string {
  const qs = new URLSearchParams({
    binanceChainId: CHAIN_ID,
    fromTokenAddress: USDT_BSC,
    toTokenAddress,
    amount: usdToBaseUnits(usd),
  });
  if (wallet) qs.set("userWalletAddress", wallet);
  return `${QUOTE_PATH}?${qs}`;
}

export function bestRoute(routes: QuoteRoute[]): QuoteRoute | undefined {
  const flagged = routes.find((r) => r.isBest);
  if (flagged) return flagged;
  return [...routes].sort((a, b) => {
    const x = BigInt(a.toTokenAmount || "0");
    const y = BigInt(b.toTokenAmount || "0");
    return x === y ? 0 : x > y ? -1 : 1;
  })[0];
}

function routeSymbols(r: QuoteRoute): string[] {
  const hops = r.dexRouterList ?? [];
  const first = hops[0]?.fromToken?.tokenSymbol ?? r.fromToken?.tokenSymbol;
  const rest = hops.map((h) => h.toToken?.tokenSymbol ?? "?");
  return first ? [first, ...rest] : rest;
}

export interface ParseQuoteContext {
  venue: Pick<Venue, "symbol" | "address" | "multiplier">;
  usd: number;
  /** Live multiplier from dynamic v2; falls back to the registry multiplier. */
  multiplier?: number | null;
  reference?: number | null;
  ts?: number;
}

export function parseQuote(ctx: ParseQuoteContext, data: unknown): ExecQuote {
  const ts = ctx.ts ?? Date.now();
  const base: QuoteBase = { symbol: ctx.venue.symbol, address: ctx.venue.address, usd: ctx.usd, ts, source: "binance-aggregator" };
  const routes = QuoteResponseSchema.parse(data ?? []);
  const r = bestRoute(routes);
  const raw = r?.toTokenAmount ? BigInt(r.toTokenAmount) : 0n;
  if (!r || raw <= 0n) {
    return { ...base, ok: false, reason: "ZERO_OUTPUT", code: null, message: routes.length ? "Best route returns 0 tokens" : "No routes returned" };
  }
  const decimals = r.toToken?.decimal ?? 18;
  const tokensOut = Number(raw) / 10 ** decimals;
  const multiplier = ctx.multiplier && ctx.multiplier > 0 ? ctx.multiplier : ctx.venue.multiplier;
  const fillPerToken = ctx.usd / tokensOut;
  const fillPerShare = fillPerToken / multiplier;
  const reference = ctx.reference && ctx.reference > 0 ? ctx.reference : null;
  return {
    ...base,
    ok: true,
    tokensOut,
    multiplier,
    fillPerToken,
    fillPerShare,
    reference,
    executableGapPct: reference === null ? null : (fillPerShare - reference) / reference,
    executionMode: r.executionMode,
    vendorName: r.vendorName,
    route: routeSymbols(r),
    protocols: (r.dexRouterList ?? []).map((h) => h.dexProtocol?.dexName ?? "?"),
    vendorPriceImpact: r.priceImpactPercent,
    networkFeeUsd: r.tradeFee,
    gasLimit: r.estimateGasFee,
    quoteId: r.quoteId,
    routeCount: routes.length,
  };
}

export function quoteFromError(ctx: ParseQuoteContext, err: ApiError): QuoteFail {
  const reason = (err.code !== null && QUOTE_REASON_BY_CODE[String(err.code)]) || "UNKNOWN_ERROR";
  return {
    symbol: ctx.venue.symbol,
    address: ctx.venue.address,
    usd: ctx.usd,
    ts: ctx.ts ?? Date.now(),
    source: "binance-aggregator",
    ok: false,
    reason,
    code: err.code ?? err.httpStatus,
    message: err.message,
  };
}

export interface QuoteOptions {
  multiplier?: number | null;
  reference?: number | null;
  wallet?: string;
  creds?: Credentials;
  limiter?: Limiter;
}

export async function getQuote(venue: Venue, usd: number, opts: QuoteOptions = {}): Promise<ExecQuote> {
  const ctx: ParseQuoteContext = { venue, usd, multiplier: opts.multiplier, reference: opts.reference };
  const wallet = opts.wallet ?? process.env.GAP_WALLET_ADDRESS;
  try {
    const data = await signedGet(quotePath(venue.address, usd, wallet), opts.creds ?? credentialsFromEnv(), {
      limiter: opts.limiter ?? quoteLimiter,
      endpoint: QUOTE_PATH,
    });
    return parseQuote({ ...ctx, ts: Date.now() }, data);
  } catch (err) {
    if (err instanceof ApiError) return quoteFromError({ ...ctx, ts: Date.now() }, err);
    throw err;
  }
}

/** Price impact of each size relative to the smallest successful quote (positive = paying more per share). */
export function ladderImpact(quotes: ExecQuote[]): Record<number, number | null> {
  const ok = quotes.filter((q): q is QuoteOk => q.ok).sort((a, b) => a.usd - b.usd);
  const base = ok[0];
  const out: Record<number, number | null> = {};
  for (const q of quotes) {
    out[q.usd] = base && q.ok ? q.fillPerShare / base.fillPerShare - 1 : null;
  }
  return out;
}

export interface Ladder {
  symbol: string;
  quotes: ExecQuote[];
  impactPct: Record<number, number | null>;
}

export async function getLadder(venue: Venue, sizes: readonly number[] = DEFAULT_LADDER, opts: QuoteOptions = {}): Promise<Ladder> {
  const quotes = await Promise.all([...sizes].sort((a, b) => a - b).map((usd) => getQuote(venue, usd, opts)));
  return { symbol: venue.symbol, quotes, impactPct: ladderImpact(quotes) };
}
