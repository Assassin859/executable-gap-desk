import pc from "picocolors";
import { PLATFORM_LABEL, type Platform } from "@gapdesk/core";

export const platformLabel = (p: Platform): string => PLATFORM_LABEL[p];

export function usd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return pc.dim("n/a");
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function pct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return pc.dim("n/a");
  const s = `${n >= 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
  const abs = Math.abs(n);
  if (abs >= 0.03) return pc.red(pc.bold(s));
  if (abs >= 0.0075) return pc.yellow(s);
  return pc.green(s);
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

export function duration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${sign}${d}d ${h}h ${m}m`;
  if (h > 0) return `${sign}${h}h ${m}m`;
  return `${sign}${m}m ${s - m * 60}s`;
}

export function dateTimes(d: Date | null): string {
  if (!d) return pc.dim("n/a");
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
  const ny = d.toLocaleString("en-US", { ...opts, timeZone: "America/New_York" });
  const ist = d.toLocaleString("en-US", { ...opts, timeZone: "Asia/Kolkata" });
  return `${ny} ET  ${pc.dim(`(${ist} IST)`)}`;
}
