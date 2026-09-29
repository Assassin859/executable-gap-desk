import { CHAIN_ID, ENDPOINTS, PLATFORM_BY_TYPE, PLATFORM_ORDER, PUBLIC_HEADERS, publicUrl, type Platform } from "./config";
import { getJson } from "./http";
import { ListSchema, type ListItem } from "./schemas";

export interface Venue {
  ticker: string;
  platform: Platform;
  symbol: string;
  address: string;
  /** Shares per token. Grows with reinvested dividends; 5 or 10 after splits. Never hardcode. */
  multiplier: number;
}

export function parseRegistry(items: ListItem[]): Venue[] {
  const venues: Venue[] = [];
  for (const item of items) {
    if (item.chainId !== CHAIN_ID) continue;
    const platform = PLATFORM_BY_TYPE[item.type];
    if (!platform) continue;
    venues.push({
      ticker: item.ticker.toUpperCase(),
      platform,
      symbol: item.symbol,
      address: item.contractAddress,
      multiplier: item.multiplier && item.multiplier > 0 ? item.multiplier : 1,
    });
  }
  return venues.sort(compareVenues);
}

export async function loadRegistry(): Promise<Venue[]> {
  const data = await getJson(publicUrl(ENDPOINTS.list), {
    headers: PUBLIC_HEADERS,
    endpoint: "rwa/stock/detail/list",
  });
  return parseRegistry(ListSchema.parse(data));
}

export function compareVenues(a: Venue, b: Venue): number {
  return (
    a.ticker.localeCompare(b.ticker) ||
    PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform) ||
    a.symbol.localeCompare(b.symbol)
  );
}

export function byTicker(venues: Venue[]): Map<string, Venue[]> {
  const map = new Map<string, Venue[]>();
  for (const v of venues) {
    const group = map.get(v.ticker);
    if (group) group.push(v);
    else map.set(v.ticker, [v]);
  }
  return map;
}

/** Tickers listed on two or more distinct platforms. */
export function multiVenue(venues: Venue[]): Map<string, Venue[]> {
  const out = new Map<string, Venue[]>();
  for (const [ticker, group] of byTicker(venues)) {
    if (new Set(group.map((v) => v.platform)).size >= 2) out.set(ticker, group);
  }
  return out;
}

export interface Resolution {
  ticker: string;
  matchedBy: "ticker" | "symbol" | "address";
  match?: Venue;
  venues: Venue[];
}

/**
 * Accepts an underlying ticker (`NVDA`), a venue symbol (`NVDAB`, `NVDAon`) or a contract address.
 * Symbols are matched case-sensitively first because `MUB` (bStocks MU) could collide with a ticker.
 */
export function resolve(venues: Venue[], query: string): Resolution | null {
  const q = query.trim();
  if (!q) return null;
  const groups = byTicker(venues);

  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const match = venues.find((v) => v.address.toLowerCase() === q.toLowerCase());
    return match ? { ticker: match.ticker, matchedBy: "address", match, venues: groups.get(match.ticker) ?? [match] } : null;
  }

  const exactSymbol = venues.find((v) => v.symbol === q);
  if (exactSymbol) {
    return { ticker: exactSymbol.ticker, matchedBy: "symbol", match: exactSymbol, venues: groups.get(exactSymbol.ticker) ?? [] };
  }

  const tickerGroup = groups.get(q.toUpperCase());
  if (tickerGroup) return { ticker: q.toUpperCase(), matchedBy: "ticker", venues: tickerGroup };

  const looseSymbol = venues.find((v) => v.symbol.toLowerCase() === q.toLowerCase());
  if (looseSymbol) {
    return { ticker: looseSymbol.ticker, matchedBy: "symbol", match: looseSymbol, venues: groups.get(looseSymbol.ticker) ?? [] };
  }
  return null;
}
