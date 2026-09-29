import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicSchema, ListSchema, parseDynamic, parseRegistry, type Venue, type VenuePrice } from "../src/index";

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

export const venueBySymbol = (symbol: string): Venue => {
  const v = fixtureVenues().find((x) => x.symbol === symbol);
  if (!v) throw new Error(`No fixture venue ${symbol}`);
  return v;
};
