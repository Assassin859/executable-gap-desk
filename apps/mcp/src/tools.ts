import {
  buildMatrix,
  buildPositions,
  checkTicker,
  getAssetStatus,
  getLadder,
  getMarketSession,
  loadRegistry,
  resolve,
  toPublicSession,
  toPublicTicker,
  type AssetStatus,
  type ExecQuote,
  type GateRunOptions,
  type Ladder,
  type MarketSession,
  type MatrixResult,
  type Positions,
  type PublicSession,
  type PublicTicker,
  type QuoteOptions,
  type TickerCheck,
  type Venue,
} from "@gapdesk/core";
import { z } from "zod";

/** Everything the tools can reach. Nothing here signs, sends or executes. */
export interface McpDeps {
  registry(): Promise<Venue[]>;
  marketSession(): Promise<MarketSession>;
  assetStatus(venue: Venue): Promise<AssetStatus>;
  matrix(ticker: string): Promise<Pick<MatrixResult, "rows">>;
  ladder(venue: Venue, sizes: number[], opts: QuoteOptions): Promise<Ladder>;
  checkTicker(ticker: string, opts: GateRunOptions): Promise<TickerCheck & { marketSession: MarketSession | null }>;
  positions(wallet: string): Promise<Positions>;
  wallet(): string | undefined;
  now(): number;
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): McpDeps {
  return {
    registry: loadRegistry,
    marketSession: () => getMarketSession(),
    assetStatus: (v) => getAssetStatus(v),
    matrix: (ticker) => buildMatrix({ scope: "all", tickers: [ticker], withSession: false }),
    ladder: (v, sizes, opts) => getLadder(v, sizes, opts),
    checkTicker: (ticker, opts) => checkTicker(ticker, opts),
    positions: (wallet) => buildPositions(wallet),
    wallet: () => env.GAP_WALLET_ADDRESS,
    now: Date.now,
  };
}

export class ToolInputError extends Error {}

export const MAX_USD = 1000;
export const MAX_SIZES = 5;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const query = z
  .string()
  .trim()
  .regex(/^(0x[0-9a-fA-F]{40}|[A-Za-z0-9.]{1,16})$/, "a ticker (NVDA), venue symbol (NVDAB, NVDAon) or BSC contract address");
const usd = z.number().positive().max(MAX_USD);

export const INPUTS = {
  resolve: { query: query.describe("Ticker, venue symbol or contract address") },
  get_market_state: { asset: query.optional().describe("Optional ticker or symbol: also return per-venue status") },
  quote_route: {
    symbol: query.describe("Venue symbol or contract address, e.g. NVDAB, AAPLon, MSTRx"),
    usd: z.array(usd).min(1).max(MAX_SIZES).default([25]).describe(`USDT sizes, at most ${MAX_SIZES}, each up to ${MAX_USD}`),
  },
  check_gate: {
    ticker: query.describe("Ticker or venue symbol"),
    usd: usd.default(25).describe(`Trade size in USDT, up to ${MAX_USD}`),
    ladder: z.boolean().default(false).describe("Also quote $100 and $500 for the price-impact rules"),
  },
  positions: {},
} as const;

type Input<K extends keyof typeof INPUTS> = z.infer<z.ZodObject<(typeof INPUTS)[K]>>;

export function parseInput<K extends keyof typeof INPUTS>(name: K, args: unknown): Input<K> {
  const r = z.object(INPUTS[name]).strict().safeParse(args ?? {});
  if (!r.success) throw new ToolInputError(r.error.issues.map((i) => `${i.path.join(".") || name}: ${i.message}`).join("; "));
  return r.data as unknown as Input<K>;
}

async function lookup(deps: McpDeps, q: string) {
  const res = resolve(await deps.registry(), q);
  if (!res) throw new ToolInputError(`No BSC tokenized stock matches "${q}".`);
  return res;
}

const venueView = (v: Venue) => ({ symbol: v.symbol, platform: v.platform, address: v.address, sharesPerToken: v.multiplier });

/** A quote without quote ids, approve targets or raw API bodies. */
function quoteView(q: ExecQuote) {
  if (!q.ok) return { ok: false as const, usd: q.usd, reason: q.reason, code: q.code === null ? null : String(q.code), message: q.message };
  return {
    ok: true as const,
    usd: q.usd,
    tokensOut: q.tokensOut,
    fillPerShare: q.fillPerShare,
    reference: q.reference,
    executableGapPct: q.executableGapPct,
    mode: q.executionMode,
    vendor: q.vendorName,
    route: q.route,
    networkFeeUsd: q.networkFeeUsd,
  };
}

const assetView = (a: AssetStatus) => ({
  open: a.open,
  session: a.session,
  reasonCode: a.reasonCode,
  nextOpen: a.nextOpen?.toISOString() ?? null,
  nextClose: a.nextClose?.toISOString() ?? null,
  sessionMissing: a.sessionMissing,
});

export async function resolveTool(deps: McpDeps, input: Input<"resolve">) {
  const res = await lookup(deps, input.query);
  return { ticker: res.ticker, matchedBy: res.matchedBy, match: res.match?.symbol ?? null, venues: res.venues.map(venueView) };
}

export async function marketStateTool(deps: McpDeps, input: Input<"get_market_state">) {
  const s = await deps.marketSession();
  const out: {
    session: PublicSession | null;
    reasonCode: string | null;
    offhours: { open: boolean; nextOpen: string | null; nextClose: string | null } | null;
    assets?: Array<{ symbol: string; platform: string; status: ReturnType<typeof assetView> }>;
  } = {
    session: toPublicSession(s),
    reasonCode: s.reasonCode,
    offhours: s.offhours
      ? { open: s.offhours.open, nextOpen: s.offhours.nextOpen?.toISOString() ?? null, nextClose: s.offhours.nextClose?.toISOString() ?? null }
      : null,
  };
  if (input.asset) {
    const res = await lookup(deps, input.asset);
    out.assets = await Promise.all(res.venues.map(async (v) => ({ symbol: v.symbol, platform: v.platform, status: assetView(await deps.assetStatus(v)) })));
  }
  return out;
}

export async function quoteRouteTool(deps: McpDeps, input: Input<"quote_route">) {
  const res = await lookup(deps, input.symbol);
  if (!res.match) {
    throw new ToolInputError(`"${input.symbol}" is a ticker; pass one venue: ${res.venues.map((v) => v.symbol).join(", ")}.`);
  }
  const venue = res.match;
  const { rows } = await deps.matrix(res.ticker);
  const row = rows.find((r) => r.address.toLowerCase() === venue.address.toLowerCase());
  const sizes = [...new Set(input.usd)].sort((a, b) => a - b);
  const ladder = await deps.ladder(venue, sizes, { multiplier: row?.multiplier, reference: row?.reference });
  return {
    symbol: venue.symbol,
    platform: venue.platform,
    reference: row?.reference ?? null,
    displayedPerShare: row?.perShare ?? null,
    quotes: ladder.quotes.map(quoteView),
    impactPct: ladder.impactPct,
    note: "Quotes are indicative USDT -> token routes; check_gate applies the desk's rules to them.",
  };
}

export async function checkGateTool(deps: McpDeps, input: Input<"check_gate">): Promise<{ checkedAt: string; session: PublicSession | null; ticker: PublicTicker }> {
  const { ticker } = await lookup(deps, input.ticker);
  const r = await deps.checkTicker(ticker, { usd: input.usd, ladderSizes: input.ladder ? [100, 500] : [] });
  return { checkedAt: new Date(deps.now()).toISOString(), session: toPublicSession(r.marketSession), ticker: toPublicTicker(r) };
}

export async function positionsTool(deps: McpDeps, _input: Input<"positions">) {
  const wallet = deps.wallet() ?? "";
  if (!ADDRESS_RE.test(wallet)) throw new ToolInputError("GAP_WALLET_ADDRESS is not set to a valid address in .env.local.");
  return deps.positions(wallet);
}

export const TOOLS = {
  resolve: {
    title: "Resolve a tokenized stock",
    description: "Every BSC venue (Ondo, xStocks, bStocks) for a ticker, venue symbol or contract address.",
    run: resolveTool,
  },
  get_market_state: {
    title: "Market session",
    description: "The US market session for tokenized stocks (regular, pre, post, overnight, closed, weekend) with the next open and close, optionally per venue.",
    run: marketStateTool,
  },
  quote_route: {
    title: "Executable quotes",
    description: "USDT -> token quotes for one venue at one or more sizes: fill per share, executable gap vs the stock, route and vendor. Read-only.",
    run: quoteRouteTool,
  },
  check_gate: {
    title: "Executable Gap gate",
    description: "Runs the desk's gate for a ticker: quotes every venue, returns GO, CAUTION or BLOCK per venue with reasons and the best venue. Read-only; never trades.",
    run: checkGateTool,
  },
  positions: {
    title: "Wallet positions",
    description: "Tokenized-stock holdings of the desk's Agentic Wallet, each with a sell quote run through the exit gate. Read-only.",
    run: positionsTool,
  },
} as const satisfies Record<keyof typeof INPUTS, { title: string; description: string; run: (deps: McpDeps, input: never) => Promise<unknown> }>;

export type ToolName = keyof typeof TOOLS;

export async function callTool(name: ToolName, args: unknown, deps: McpDeps): Promise<unknown> {
  const input = parseInput(name, args);
  return (TOOLS[name].run as (d: McpDeps, i: typeof input) => Promise<unknown>)(deps, input);
}
