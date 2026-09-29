import type { PublicSnapshot, PublicTicker } from "@gapdesk/core";
import data from "../data/snapshot.json";

export const SNAPSHOT = data as unknown as PublicSnapshot;

export function snapshotTicker(ticker: string): PublicTicker | undefined {
  const t = ticker.toUpperCase();
  return SNAPSHOT.tickers.find((x) => x.ticker === t);
}
