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
