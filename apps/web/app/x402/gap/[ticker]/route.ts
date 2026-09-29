import { geoRefused } from "@/lib/radar";
import { liveCheck, TICKER_RE } from "@/lib/server";
import { PRICES_U, tickerBazaar, withX402 } from "@/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const ticker = (await ctx.params).ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) return Response.json({ error: "Not a ticker." }, { status: 400 });
  const description = `Executable gap gate for ${ticker}: every BSC tokenized-stock venue (Ondo, xStocks, bStocks) quoted at $25, with verdict and reasons.`;
  return withX402(req, {
    priceU: PRICES_U.gap,
    description,
    bazaar: tickerBazaar("Executable-gap gate JSON for one US stock across BSC tokenized-stock venues", "/x402/gap/:ticker", ticker),
    work: async () => {
      const check = await liveCheck(ticker, false);
      if (geoRefused(check.ticker)) throw new Error("The Binance quote API refused this server's region (40304)");
      return { ...check, paidEndpoint: "/x402/gap/:ticker", priceU: PRICES_U.gap };
    },
  });
}
