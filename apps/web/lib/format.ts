import type { Platform, SessionName, Verdict } from "@gapdesk/core";

export const PLATFORM_LABEL: Record<Platform, string> = { ondo: "Ondo", xstocks: "xStocks", bstocks: "bStocks" };

export const SESSION_LABEL: Record<SessionName, string> = {
  premarket: "US premarket",
  regular: "US regular session",
  postmarket: "US after-hours",
  overnight: "US overnight",
  closed: "US market closed",
  pause: "Trading paused",
  weekend: "Weekend",
  unknown: "Session unknown",
};

export const VERDICT_RANK: Record<Verdict, number> = { GO: 0, CAUTION: 1, BLOCK: 2 };

export function pct(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "n/a";
  const v = x * 100;
  if (Math.abs(v) >= 1000) return `${v >= 0 ? "+" : ""}${Math.round(v).toLocaleString("en-US")}%`;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "n/a";
  if (x >= 1e6) return `$${x.toExponential(2)}`;
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ago(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function countdown(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

export const utc = (ts: number | string): string => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export const shortHash = (h: string): string => `${h.slice(0, 6)}…${h.slice(-4)}`;
