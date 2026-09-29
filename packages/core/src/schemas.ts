import { z } from "zod";

/** Numeric fields arrive as strings (sometimes 40+ digits), numbers, empty strings or null. */
const num = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  });

const str = z.string().nullish().transform((v) => (v ? v : null));

export const ListItemSchema = z.looseObject({
  chainId: z.union([z.string(), z.number()]).transform(String),
  contractAddress: z.string(),
  symbol: z.string(),
  ticker: z.string(),
  type: z.coerce.number(),
  multiplier: num,
});
export const ListSchema = z.array(ListItemSchema);
export type ListItem = z.infer<typeof ListItemSchema>;

export const StatusInfoSchema = z.looseObject({
  openState: z.boolean().nullish(),
  marketStatus: str,
  reasonCode: str,
  reasonMsg: str,
  nextOpenTime: num,
  nextCloseTime: num,
});
export type StatusInfo = z.infer<typeof StatusInfoSchema>;

export const MarketStatusSchema = StatusInfoSchema.extend({
  nextOpen: str,
  nextClose: str,
  offhours: z
    .looseObject({
      openState: z.boolean().nullish(),
      nextOpenTime: num,
      nextCloseTime: num,
    })
    .nullish(),
});
export type MarketStatus = z.infer<typeof MarketStatusSchema>;

export const DynamicSchema = z.looseObject({
  symbol: str,
  ticker: str,
  type: z.coerce.number().nullish(),
  tokenInfo: z
    .looseObject({
      price: num,
      priceChangePct24h: num,
      totalHolders: num,
      sharesMultiplier: num,
      marketCap: num,
      circulatingSupply: num,
      bnHolder: num,
      bnTrader: num,
    })
    .nullish(),
  stockInfo: z
    .looseObject({
      price: num,
      priceHigh52w: num,
      priceLow52w: num,
      priceToEarnings: num,
      dividendYield: num,
    })
    .nullish(),
  statusInfo: StatusInfoSchema.nullish(),
  limitInfo: z
    .looseObject({
      maxAttestationCount: num,
      maxActiveNotionalValue: num,
    })
    .nullish(),
});
export type Dynamic = z.infer<typeof DynamicSchema>;

const QuoteTokenSchema = z.looseObject({
  tokenContractAddress: z.string(),
  tokenSymbol: str,
  tokenUnitPrice: num,
  decimal: z.coerce.number(),
});

/** One route from GET /api/v1/dex/aggregator/quote; the docs publish no response schema, so this mirrors live responses. */
export const QuoteRouteSchema = z.looseObject({
  quoteId: str,
  vendorName: str,
  executionMode: str,
  fromTokenAmount: z.string(),
  toTokenAmount: z.string().nullish(),
  tradeFee: num,
  estimateGasFee: num,
  priceImpactPercent: num,
  router: str,
  approveTarget: str,
  isBest: z.boolean().nullish(),
  fromToken: QuoteTokenSchema.nullish(),
  toToken: QuoteTokenSchema.nullish(),
  dexRouterList: z
    .array(
      z.looseObject({
        dexProtocol: z.looseObject({ dexName: str, percent: num }).nullish(),
        fromToken: QuoteTokenSchema.nullish(),
        toToken: QuoteTokenSchema.nullish(),
      }),
    )
    .nullish(),
});
export const QuoteResponseSchema = z.array(QuoteRouteSchema);
export type QuoteRoute = z.infer<typeof QuoteRouteSchema>;

/** Integer amounts (wei, gas) kept as exact decimal strings. */
const intStr = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((v) => /^\d+$/.test(v), "expected an unsigned integer string");
const optIntStr = intStr.nullish().transform((v) => v ?? null);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "expected 0x-prefixed hex");

/** GET /aggregator/approve-transaction: `data` is ERC-20 approve() calldata; `dexContractAddress` is the spender. */
export const ApproveTxSchema = z.looseObject({
  data: hex,
  dexContractAddress: z.string(),
  gasLimit: optIntStr,
  gasPrice: optIntStr,
});
export const ApproveResponseSchema = z.array(ApproveTxSchema).min(1);
export type ApproveTx = z.infer<typeof ApproveTxSchema>;

export const SwapTxSchema = z.looseObject({
  from: z.string(),
  to: z.string(),
  data: hex,
  value: intStr,
  gas: optIntStr,
  gasPrice: optIntStr,
  maxPriorityFeePerGas: optIntStr,
  minReceiveAmount: optIntStr,
  slippagePercent: num,
});
export type SwapTx = z.infer<typeof SwapTxSchema>;

/** GET /aggregator/swap: `tx` for SWAP routes, `rfq` for RFQ routes (never seen live so far). */
export const SwapResponseSchema = z.looseObject({
  executionMode: str,
  routerResult: z
    .looseObject({
      vendorName: str,
      fromTokenAmount: optIntStr,
      toTokenAmount: optIntStr,
      router: str,
      priceImpactPercent: num,
      tradeFee: num,
    })
    .nullish(),
  tx: SwapTxSchema.nullish(),
  rfq: z.unknown().nullish(),
});
export type SwapResponse = z.infer<typeof SwapResponseSchema>;

/** POST /pre-transaction/simulate. A revert is `status: "FAILED"` with `failReason`, not an error code. */
export const SimulateResponseSchema = z.looseObject({
  status: z.string(),
  failReason: str,
  balanceChanges: z
    .array(
      z.looseObject({
        contractAddress: z.string(),
        tokenType: str,
        change: z.string().regex(/^-?\d+$/),
        owner: z.string(),
      }),
    )
    .nullish()
    .transform((v) => v ?? []),
  allowanceChanges: z.array(z.unknown()).nullish().transform((v) => v ?? []),
});
export type SimulateResult = z.infer<typeof SimulateResponseSchema>;
