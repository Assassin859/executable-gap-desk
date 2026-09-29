import { ENDPOINTS, PUBLIC_HEADERS, publicUrl, type Platform } from "./config";
import { getJson } from "./http";
import type { Venue } from "./registry";
import { DynamicSchema, type Dynamic } from "./schemas";
import { normalizeAssetStatus, type AssetStatus } from "./session";

export interface VenuePrice {
  venue: Venue;
  /** On-chain token price in USD (per token, not per share). */
  tokenPrice: number | null;
  /** Dynamic `sharesMultiplier`, falling back to the registry value (the list reports 1 for every xStock). */
  multiplier: number;
  multiplierSource: "dynamic" | "registry";
  perShare: number | null;
  /** Underlying US stock price from `stockInfo.price`. Null for bStocks and sometimes off-hours. */
  stockPrice: number | null;
  status: AssetStatus;
  holders: number | null;
  fetchedAt: number;
}

export interface Reference {
  price: number | null;
  source: Platform | "none";
}

export function parseDynamic(venue: Venue, data: Dynamic, fetchedAt: number = Date.now()): VenuePrice {
  const tokenPrice = data.tokenInfo?.price ?? null;
  const dynMult = data.tokenInfo?.sharesMultiplier ?? null;
  const multiplier = dynMult && dynMult > 0 ? dynMult : venue.multiplier;
  return {
    venue,
    tokenPrice,
    multiplier,
    multiplierSource: dynMult && dynMult > 0 ? "dynamic" : "registry",
    perShare: tokenPrice !== null ? tokenPrice / multiplier : null,
    stockPrice: data.stockInfo?.price ?? null,
    status: normalizeAssetStatus(data.statusInfo, fetchedAt),
    holders: data.tokenInfo?.totalHolders ?? data.tokenInfo?.bnHolder ?? null,
    fetchedAt,
  };
}

export async function getDynamic(venue: Venue): Promise<VenuePrice> {
  const data = await getJson(publicUrl(ENDPOINTS.dynamic, { chainId: "56", contractAddress: venue.address }), {
    headers: PUBLIC_HEADERS,
    endpoint: "rwa/dynamic",
  });
  return parseDynamic(venue, DynamicSchema.parse(data));
}

const REFERENCE_PREFERENCE: readonly Platform[] = ["ondo", "xstocks", "bstocks"];

/**
 * The reference is the underlying stock price reported alongside any venue of the ticker
 * (identical across venues), preferring Ondo. A venue's own price/multiplier is never used:
 * that would compare a market with itself.
 */
export function referenceFor(prices: VenuePrice[]): Reference {
  for (const platform of REFERENCE_PREFERENCE) {
    const hit = prices.find((p) => p.venue.platform === platform && p.stockPrice !== null && p.stockPrice > 0);
    if (hit) return { price: hit.stockPrice, source: platform };
  }
  return { price: null, source: "none" };
}

export function gapPct(perShare: number | null, reference: number | null): number | null {
  if (perShare === null || reference === null || reference <= 0) return null;
  return (perShare - reference) / reference;
}
