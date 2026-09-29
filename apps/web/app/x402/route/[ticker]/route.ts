import { geoRefused } from "@/lib/radar";
import { liveCheck, TICKER_RE } from "@/lib/server";
import { PRICES_U, tickerBazaar, withX402 } from "@/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_USD = 25;

export async function GET(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const ticker = (await ctx.params).ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) return Response.json({ error: "Not a ticker." }, { status: 400 });
  const raw = new URL(req.url).searchParams.get("usd") ?? String(MAX_USD);
  const usd = Number(raw);
  if (!/^\d+(\.\d{1,2})?$/.test(raw) || !(usd >= 1 && usd <= MAX_USD)) {
    return Response.json({ error: `usd must be between 1 and ${MAX_USD} (at most 2 decimals).` }, { status: 400 });
  }
  return withX402(req, {
    priceU: PRICES_U.route,
    description: `Best executable BSC venue for $${usd} of ${ticker}: venue, per-share fill, swap route and verdict.`,
    bazaar: tickerBazaar("Best executable BSC tokenized-stock venue, fill price and route for a USD size", "/x402/route/:ticker", ticker, { usd: String(usd) }),
    work: async () => {
      const check = await liveCheck(ticker, false, usd);
      if (geoRefused(check.ticker)) throw new Error("The Binance quote API refused this server's region (40304)");
      const t = check.ticker;
      const best = t.best ? t.venues.find((v) => v.symbol === t.best) ?? null : null;
      return {
        ticker,
        usd,
        checkedAt: check.checkedAt,
        session: check.session,
        reference: t.reference,
        referenceSource: t.referenceSource,
        verdict: best?.verdict ?? "BLOCK",
        best: best
          ? {
              symbol: best.symbol,
              platform: best.platform,
              address: best.address,
              fillPerShare: best.fillPerShare,
              executableGapPct: best.executableGapPct,
              route: best.quote?.ok ? best.quote.route : [],
              vendor: best.quote?.ok ? best.quote.vendor : null,
              networkFeeUsd: best.quote?.ok ? best.quote.networkFeeUsd : null,
              reasons: best.reasons,
            }
          : null,
        otherVenues: t.venues.filter((v) => v.symbol !== t.best).map((v) => ({ symbol: v.symbol, verdict: v.verdict, reason: v.reasons.find((r) => r.severity !== "info")?.message ?? null })),
        paidEndpoint: "/x402/route/:ticker",
        priceU: PRICES_U.route,
      };
    },
  });
}
