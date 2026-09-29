import { CHAIN_ID } from "./config";
import { quoteLimiter, type Limiter } from "./http";
import { bestRoute, QUOTE_PATH } from "./quotes";
import {
  ApproveResponseSchema,
  QuoteResponseSchema,
  SimulateResponseSchema,
  SwapResponseSchema,
  type ApproveTx,
  type QuoteRoute,
  type SimulateResult,
  type SwapResponse,
} from "./schemas";
import { credentialsFromEnv, signedGet, signedPost, type Credentials } from "./signer";

export const NATIVE_BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const APPROVE_PATH = "/api/v1/dex/aggregator/approve-transaction";
export const SWAP_PATH = "/api/v1/dex/aggregator/swap";
export const SIMULATE_PATH = "/api/v1/dex/pre-transaction/simulate";
export const TX_DETAIL_PATH = "/api/v1/dex/post-transaction/transaction-detail-by-txhash";

export interface TradeApiOptions {
  creds?: Credentials;
  limiter?: Limiter;
}

const call = (opts: TradeApiOptions) => ({ creds: opts.creds ?? credentialsFromEnv(), limiter: opts.limiter ?? quoteLimiter });

export interface RouteParams {
  fromToken: string;
  toToken: string;
  /** Sell amount in the from-token's base units. */
  amount: string;
  wallet: string;
}

const routeQuery = (p: RouteParams) => ({
  binanceChainId: CHAIN_ID,
  fromTokenAddress: p.fromToken,
  toTokenAddress: p.toToken,
  amount: p.amount,
  userWalletAddress: p.wallet,
});

export function rawQuotePath(p: RouteParams): string {
  return `${QUOTE_PATH}?${new URLSearchParams(routeQuery(p))}`;
}

/** Any-pair quote (e.g. BNB to USDT for funding); stock quotes go through `getQuote`. */
export async function quoteRoute(p: RouteParams, opts: TradeApiOptions = {}): Promise<{ route: QuoteRoute; routeCount: number }> {
  const { creds, limiter } = call(opts);
  const routes = QuoteResponseSchema.parse(await signedGet(rawQuotePath(p), creds, { limiter, endpoint: QUOTE_PATH }));
  const route = bestRoute(routes);
  if (!route?.quoteId || !route.toTokenAmount || BigInt(route.toTokenAmount) <= 0n) throw new Error("Quote returned no usable route");
  return { route, routeCount: routes.length };
}

export function approvePath(token: string, amount: string): string {
  return `${APPROVE_PATH}?${new URLSearchParams({ binanceChainId: CHAIN_ID, tokenContractAddress: token, approveAmount: amount })}`;
}

export async function getApproveTx(token: string, amount: string, opts: TradeApiOptions = {}): Promise<ApproveTx> {
  const { creds, limiter } = call(opts);
  return ApproveResponseSchema.parse(await signedGet(approvePath(token, amount), creds, { limiter, endpoint: APPROVE_PATH }))[0]!;
}

export interface SwapParams extends RouteParams {
  quoteId: string;
  /** Percent, e.g. 0.5 for 0.5%. */
  slippagePct: number;
}

export function swapPath(p: SwapParams): string {
  return `${SWAP_PATH}?${new URLSearchParams({ ...routeQuery(p), quoteId: p.quoteId, slippagePercent: String(p.slippagePct) })}`;
}

export async function buildSwap(p: SwapParams, opts: TradeApiOptions = {}): Promise<SwapResponse> {
  const { creds, limiter } = call(opts);
  return SwapResponseSchema.parse(await signedGet(swapPath(p), creds, { limiter, endpoint: SWAP_PATH }));
}

export interface EvmTx {
  from: string;
  to: string;
  data: string;
  value: string;
  gasLimit?: string | null;
  gasPrice?: string | null;
}

export function simulateBody(tx: EvmTx) {
  const evmTx: Record<string, string> = { from: tx.from, to: tx.to, data: tx.data, value: tx.value };
  if (tx.gasLimit) evmTx.gasLimit = tx.gasLimit;
  if (tx.gasPrice) evmTx.gasPrice = tx.gasPrice;
  return { binanceChainId: CHAIN_ID, evmTx };
}

export async function simulateTx(tx: EvmTx, opts: TradeApiOptions = {}): Promise<SimulateResult> {
  const { creds, limiter } = call(opts);
  return SimulateResponseSchema.parse(await signedPost(SIMULATE_PATH, simulateBody(tx), creds, { limiter, endpoint: SIMULATE_PATH }));
}

/** Net change for one owner and token from a simulation, in base units (negative = spent). */
export function simulatedChange(sim: SimulateResult, owner: string, token: string): bigint {
  const o = owner.toLowerCase();
  const t = token.toLowerCase();
  return sim.balanceChanges
    .filter((c) => c.owner.toLowerCase() === o && c.contractAddress.toLowerCase() === t)
    .reduce((sum, c) => sum + BigInt(c.change), 0n);
}

/** Raw transaction detail from the Transaction API; stored in receipts as the API's own view of the fill. */
export async function txDetail(txHash: string, opts: TradeApiOptions = {}): Promise<unknown> {
  const { creds, limiter } = call(opts);
  const qs = new URLSearchParams({ binanceChainId: CHAIN_ID, txHash });
  return signedGet(`${TX_DETAIL_PATH}?${qs}`, creds, { limiter, endpoint: TX_DETAIL_PATH });
}
