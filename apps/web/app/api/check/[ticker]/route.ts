import { geoRefused } from "@/lib/radar";
import { clientIp, hasCredentials, isCachedCheck, liveCheck, liveThrottle, TICKER_RE } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const ticker = (await ctx.params).ticker.toUpperCase();
  const ladder = new URL(req.url).searchParams.get("ladder") === "1";
  if (!TICKER_RE.test(ticker)) return Response.json({ error: "Not a ticker." }, { status: 400 });
  if (!hasCredentials()) return Response.json({ error: "Live quotes are unavailable on this deployment (no API keys configured)." }, { status: 503 });
  if (!isCachedCheck(ticker, ladder) && !liveThrottle.allow(clientIp(req.headers))) {
    return Response.json({ error: "Too many live checks; try again in a minute." }, { status: 429 });
  }
  try {
    const check = await liveCheck(ticker, ladder);
    if (geoRefused(check.ticker)) {
      return Response.json({ error: "The Binance quote API refused this server's region (40304), so no live quote. The snapshot cards above still apply." }, { status: 503 });
    }
    return Response.json(check, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg.startsWith("No BSC tokenized stock") ? msg : "Live check failed; try again shortly." }, { status: msg.startsWith("No BSC") ? 404 : 502 });
  }
}
