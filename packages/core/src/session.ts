import { ENDPOINTS, PUBLIC_HEADERS, publicUrl } from "./config";
import { getJson } from "./http";
import type { Venue } from "./registry";
import { MarketStatusSchema, StatusInfoSchema, type MarketStatus, type StatusInfo } from "./schemas";

export type SessionName =
  | "premarket"
  | "regular"
  | "postmarket"
  | "overnight"
  | "closed"
  | "pause"
  | "weekend"
  | "unknown";

export interface SessionEvent {
  type: "open" | "close";
  at: Date;
}

export interface MarketSession {
  session: SessionName;
  /** The API's `openState`: tokens are tradable in the current session. */
  open: boolean;
  reasonCode: string | null;
  reasonMsg: string | null;
  nextOpen: Date | null;
  nextClose: Date | null;
  /** The earlier of nextOpen/nextClose that is still in the future. */
  nextEvent: SessionEvent | null;
  /** Weekend trading window reported by the API (`offhours`), when present. */
  offhours: { open: boolean; nextOpen: Date | null; nextClose: Date | null } | null;
  raw: MarketStatus;
}

export interface AssetStatus {
  open: boolean | null;
  session: SessionName;
  reasonCode: string | null;
  reasonMsg: string | null;
  nextOpen: Date | null;
  nextClose: Date | null;
  /** xStocks and bStocks return `marketStatus: null` and no times; only `reasonCode` is filled. */
  sessionMissing: boolean;
}

const KNOWN: ReadonlySet<string> = new Set(["premarket", "regular", "postmarket", "overnight", "closed", "pause"]);
const DAY_MS = 24 * 60 * 60 * 1000;

const toDate = (ms: number | null | undefined): Date | null => (ms ? new Date(ms) : null);

function nySessionIsWeekend(now: number): boolean {
  const day = new Date(now).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
  return day === "Sat" || day === "Sun";
}

function earliestFuture(now: number, events: Array<SessionEvent | null>): SessionEvent | null {
  let best: SessionEvent | null = null;
  for (const e of events) {
    if (!e || e.at.getTime() <= now) continue;
    if (!best || e.at < best.at) best = e;
  }
  return best;
}

function normalizeSessionName(status: string | null, open: boolean | null, nextOpen: Date | null, now: number): SessionName {
  const s = status?.toLowerCase() ?? null;
  const base: SessionName = s && KNOWN.has(s) ? (s as SessionName) : "unknown";
  const closedLike = base === "closed" || (base === "unknown" && open === false);
  if (closedLike) {
    const longGap = nextOpen !== null && nextOpen.getTime() - now > DAY_MS;
    if (longGap || nySessionIsWeekend(now)) return "weekend";
    return "closed";
  }
  return base;
}

/**
 * The API's nextOpen/nextClose are state-dependent: while open, nextClose < nextOpen; while
 * closed, nextOpen < nextClose. We keep both and expose the soonest future one as `nextEvent`.
 */
export function normalizeMarketStatus(raw: MarketStatus, now: number = Date.now()): MarketSession {
  const nextOpen = toDate(raw.nextOpenTime);
  const nextClose = toDate(raw.nextCloseTime);
  const open = raw.openState ?? false;
  return {
    session: normalizeSessionName(raw.marketStatus, raw.openState ?? null, nextOpen, now),
    open,
    reasonCode: raw.reasonCode,
    reasonMsg: raw.reasonMsg,
    nextOpen,
    nextClose,
    nextEvent: earliestFuture(now, [
      nextOpen ? { type: "open", at: nextOpen } : null,
      nextClose ? { type: "close", at: nextClose } : null,
    ]),
    offhours: raw.offhours
      ? {
          open: raw.offhours.openState ?? false,
          nextOpen: toDate(raw.offhours.nextOpenTime),
          nextClose: toDate(raw.offhours.nextCloseTime),
        }
      : null,
    raw,
  };
}

export function normalizeAssetStatus(raw: StatusInfo | null | undefined, now: number = Date.now()): AssetStatus {
  if (!raw) {
    return { open: null, session: "unknown", reasonCode: null, reasonMsg: null, nextOpen: null, nextClose: null, sessionMissing: true };
  }
  const nextOpen = toDate(raw.nextOpenTime);
  return {
    open: raw.openState ?? null,
    session: raw.marketStatus ? normalizeSessionName(raw.marketStatus, raw.openState ?? null, nextOpen, now) : "unknown",
    reasonCode: raw.reasonCode,
    reasonMsg: raw.reasonMsg,
    nextOpen,
    nextClose: toDate(raw.nextCloseTime),
    sessionMissing: !raw.marketStatus,
  };
}

export async function getMarketSession(now: number = Date.now()): Promise<MarketSession> {
  const data = await getJson(publicUrl(ENDPOINTS.marketStatus), {
    headers: PUBLIC_HEADERS,
    endpoint: "rwa/market/status",
  });
  return normalizeMarketStatus(MarketStatusSchema.parse(data), now);
}

export async function getAssetStatus(venue: Venue, now: number = Date.now()): Promise<AssetStatus> {
  const data = await getJson(publicUrl(ENDPOINTS.assetStatus, { chainId: "56", contractAddress: venue.address }), {
    headers: PUBLIC_HEADERS,
    endpoint: "rwa/asset/market/status",
  });
  return normalizeAssetStatus(StatusInfoSchema.parse(data), now);
}
