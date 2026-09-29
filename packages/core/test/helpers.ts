import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApiError,
  DynamicSchema,
  ListSchema,
  parseDynamic,
  parseQuote,
  parseRegistry,
  quoteFromError,
  type ExecQuote,
  type Venue,
  type VenuePrice,
} from "../src/index";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(resolve(dir, name), "utf8")) as T;
}

export const fixtureVenues = (): Venue[] => parseRegistry(ListSchema.parse(fixture("list.json")));

const FIXTURE_TIME = Date.parse(fixture<{ recordedAt: string }>("meta.json").recordedAt);

export function fixturePrice(venue: Venue): VenuePrice {
  const all = fixture<Record<string, unknown>>("dynamic.json");
  const raw = all[venue.symbol];
  if (!raw) throw new Error(`No dynamic fixture for ${venue.symbol}`);
  return parseDynamic(venue, DynamicSchema.parse(raw), FIXTURE_TIME);
}

type QuoteFixture = { ok: true; data: unknown } | { ok: false; httpStatus: number | null; code: number | string | null; msg: string };
export const QUOTE_TIME = Date.parse(fixture<{ recordedAt: string }>("quotes.json").recordedAt);

export function rawQuote(symbol: string, usd: number): QuoteFixture {
  const q = fixture<{ quotes: Record<string, QuoteFixture> }>("quotes.json").quotes[`${symbol}@${usd}`];
  if (!q) throw new Error(`No quote fixture ${symbol}@${usd}`);
  return q;
}

/** Recorded quote parsed the same way getQuote would, using the fixture's live multiplier. */
export function fixtureQuote(symbol: string, usd: number, reference: number | null): ExecQuote {
  const venue = venueBySymbol(symbol);
  const ctx = { venue, usd, multiplier: fixturePrice(venue).multiplier, reference, ts: QUOTE_TIME };
  const q = rawQuote(symbol, usd);
  return q.ok
    ? parseQuote(ctx, q.data)
    : quoteFromError(ctx, new ApiError({ endpoint: "/quote", httpStatus: q.httpStatus, code: q.code, msg: q.msg }));
}

export const venueBySymbol = (symbol: string): Venue => {
  const v = fixtureVenues().find((x) => x.symbol === symbol);
  if (!v) throw new Error(`No fixture venue ${symbol}`);
  return v;
};
