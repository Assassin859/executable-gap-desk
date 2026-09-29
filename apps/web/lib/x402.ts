import "server-only";
import { b402Config, cachedKinds, createB402Client, createNonceGuard, sellX402, type B402Client, type B402Kind, type Bazaar } from "@gapdesk/core";
import { clientIp, liveThrottle, loadLocalEnv } from "./server";

export const PRICES_U = { gap: "0.01", route: "0.02" } as const;

let seller: { client: B402Client; kinds: () => Promise<B402Kind[]>; payTo: string } | null = null;
const guard = createNonceGuard();

/** The B402 client, cached `/supported` kinds and receiving address; null when the env is incomplete. */
export function getSeller(): { client: B402Client; kinds: () => Promise<B402Kind[]>; payTo: string } | { missing: string[] } {
  loadLocalEnv();
  if (seller) return seller;
  const cfg = b402Config(process.env);
  if (!cfg.creds || !cfg.payTo) return { missing: cfg.missing };
  const client = createB402Client(cfg.creds);
  seller = { client, kinds: cachedKinds(client), payTo: cfg.payTo };
  return seller;
}

const EXPOSE = { "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE", "Cache-Control": "no-store" };

export interface X402Route {
  priceU: string;
  description: string;
  bazaar?: Bazaar;
  work(): Promise<unknown>;
}

/**
 * x402 v2 over B402. Unpaid requests get a 402 with the requirements; paid ones are verified, served,
 * then settled into the Agentic Wallet. Paid attempts share the live-check throttle because each one
 * runs quotes and two signed B402 calls.
 */
export async function withX402(req: Request, route: X402Route): Promise<Response> {
  const s = getSeller();
  if ("missing" in s) {
    return Response.json({ errorCode: "seller_not_configured", error: "This deployment has no B402 seller configured.", missing: s.missing }, { status: 503, headers: EXPOSE });
  }
  const proof = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  if (proof && !liveThrottle.allow(clientIp(req.headers))) {
    return Response.json({ error: "Too many paid requests; try again in a minute." }, { status: 429, headers: EXPOSE });
  }
  try {
    const r = await sellX402(
      {
        priceU: route.priceU,
        resource: { url: req.url, description: route.description, mimeType: "application/json" },
        ...(route.bazaar ? { bazaar: route.bazaar } : {}),
        proof,
        work: route.work,
      },
      { client: s.client, payTo: s.payTo, kinds: s.kinds, guard, now: Date.now },
    );
    if (r.status === 200) console.log(`x402 sale ${route.priceU} U ${new URL(req.url).pathname} tx=${r.settlement.transaction ?? "none"} payer=${r.settlement.payer ?? "?"}`);
    else if (proof) console.log(`x402 refused ${new URL(req.url).pathname}: ${JSON.stringify({ status: r.status, error: r.body.error, reason: "reason" in r.body ? r.body.reason : undefined })}`);
    return Response.json(r.body, { status: r.status, headers: { ...EXPOSE, ...r.headers } });
  } catch (err) {
    return Response.json({ error: "b402_unavailable", message: err instanceof Error ? err.message : String(err) }, { status: 502, headers: EXPOSE });
  }
}

/** Bazaar listing for a `GET /x402/<kind>/:ticker` endpoint. */
export function tickerBazaar(description: string, routeTemplate: string, ticker: string, query?: Record<string, string>): Bazaar {
  return {
    description,
    routeTemplate,
    info: { input: { type: "http", method: "GET", pathParams: { ticker }, ...(query ? { queryParams: query } : {}) } },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: { type: { const: "http" }, method: { enum: ["GET"] } },
          required: ["type", "method"],
        },
      },
      required: ["input"],
    },
  };
}
