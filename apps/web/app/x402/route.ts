import { b402Ready, buildRequirements, priceToAmount } from "@gapdesk/core";
import { getSeller, PRICES_U } from "@/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const endpoints = [
    { method: "GET", path: "/x402/gap/:ticker", priceU: PRICES_U.gap, returns: "Gate JSON for every BSC venue of the stock (Ondo, xStocks, bStocks) at $25: displayed vs executable gap, verdict, reasons." },
    { method: "GET", path: "/x402/route/:ticker?usd=1..25", priceU: PRICES_U.route, returns: "Best executable venue for the size: per-share fill, swap route, network fee, verdict." },
  ];
  const base = {
    x402Version: 2,
    name: "Executable Gap Desk",
    facilitator: "Binance B402",
    network: "eip155:56",
    endpoints,
    howToPay: [
      `curl -i ${origin}/x402/gap/NVDA   # 402 with a base64 PAYMENT-REQUIRED header`,
      "sign one of `accepts` (EIP-3009 transferWithAuthorization, no approval needed), then retry with the base64 proof in PAYMENT-SIGNATURE",
      "Binance Agentic Wallet: baw x402-payment preview --paymentRequirements <PAYMENT-REQUIRED>, then baw x402-payment sign --paymentId <id> --selectedIndex <n>",
      "or with this repo: pnpm gap x402 <url> --live",
    ],
    identity: `${origin}/.well-known/agent-card.json`,
  };
  const s = getSeller();
  if ("missing" in s) return Response.json({ ...base, configured: false, errorCode: "seller_not_configured" }, { headers: { "Cache-Control": "no-store" } });
  try {
    const kinds = await s.kinds();
    const ready = await b402Ready({ supported: async () => ({ kinds }) });
    return Response.json(
      {
        ...base,
        configured: true,
        payTo: s.payTo,
        acceptedTokens: ready.sellable,
        accepts: { gap: buildRequirements(kinds, { amount: priceToAmount(PRICES_U.gap), payTo: s.payTo }) },
        b402: { kinds: ready.kinds, offers: ready.offers },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json({ ...base, configured: true, errorCode: "b402_unavailable", message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
