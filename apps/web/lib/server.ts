import "server-only";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkTicker, credentialsFromEnv, getMarketSession, toPublicSession, toPublicTicker, type PublicSession, type PublicTicker } from "@gapdesk/core";
import { createThrottle, createTtlCache } from "./cache";

/** `next dev` / `next build` run with apps/web as the working directory. */
export const REPO_ROOT = resolve(/*turbopackIgnore: true*/ process.cwd(), "../..");

let envLoaded = false;
/** Locally, reuse the repo-root .env.local the CLI uses. On Vercel the keys come from project env vars and the file does not exist. */
export function loadLocalEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const file = resolve(REPO_ROOT, ".env.local");
  if (!process.env.BW3_API_KEY && existsSync(/*turbopackIgnore: true*/ file)) process.loadEnvFile(file);
}

export function hasCredentials(): boolean {
  loadLocalEnv();
  try {
    credentialsFromEnv();
    return true;
  } catch {
    return false;
  }
}

export interface LiveCheck {
  checkedAt: number;
  ladder: boolean;
  session: PublicSession | null;
  ticker: PublicTicker;
}

const checks = createTtlCache<LiveCheck>(60_000);
const sessions = createTtlCache<PublicSession | null>(30_000);
export const liveThrottle = createThrottle(12, 60_000);

export function liveCheck(ticker: string, ladder: boolean, usd = 25): Promise<LiveCheck> {
  loadLocalEnv();
  return checks.get(usd === 25 ? `${ticker}:${ladder}` : `${ticker}:${ladder}:${usd}`, async () => {
    const r = await checkTicker(ticker, { usd, ladderSizes: ladder ? [100, 500] : [] });
    return { checkedAt: Date.now(), ladder, session: toPublicSession(r.marketSession), ticker: toPublicTicker(r) };
  });
}

export const isCachedCheck = (ticker: string, ladder: boolean): boolean => checks.has(`${ticker}:${ladder}`);

export function liveSession(): Promise<PublicSession | null> {
  return sessions.get("session", async () => toPublicSession(await getMarketSession()));
}

export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "local";
}

export const TICKER_RE = /^[A-Z0-9.]{1,12}$/;
