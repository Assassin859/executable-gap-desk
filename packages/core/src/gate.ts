import { z } from "zod";
import defaultPolicyJson from "../policy/default.json" with { type: "json" };
import type { Platform } from "./config";
import type { MatrixRow } from "./matrix";
import { QUOTE_REASON_TEXT, ladderImpact, type ExecQuote, type QuoteOk, type Side } from "./quotes";
import type { SessionName } from "./session";

export type Verdict = "GO" | "CAUTION" | "BLOCK";
const RANK: Record<Verdict, number> = { GO: 0, CAUTION: 1, BLOCK: 2 };

const frac = z.number().positive().lt(1);

export const PolicySchema = z
  .strictObject({
    version: z.literal(1),
    maxTradeUsd: z.number().positive(),
    quoteMaxAgeSec: z.number().positive(),
    goMaxGapPct: frac,
    cautionMaxGapPct: frac,
    maxDisplayedVsExecutablePct: frac,
    maxSpreadAtBasePct: frac,
    impactCautionUsd: z.number().positive(),
    impactCautionPct: frac,
    maxVenueDisagreementPct: frac,
    offHoursMaxVerdict: z.enum(["GO", "CAUTION", "BLOCK"]),
    /** Execution only: live USDT spent on stock fills per UTC day, summed from receipts. */
    maxDailySpendUsd: z.number().positive(),
    /** Execution only: `/swap` slippage in percent (0.5 = 0.5%), which sets `minReceiveAmount`. */
    slippagePct: z.number().positive().max(5),
    /** Execution only: USDT committed per gap-guarded limit buy. */
    maxLimitOrderUsd: z.number().positive(),
    /** Execution only: how far the Agentic Wallet's market-order quote may sit from the gated aggregator quote. */
    maxWalletQuoteDeviationPct: frac,
    /** Execution only: how long to poll a market order before recording it as PENDING. */
    marketOrderTimeoutSec: z.number().positive(),
  })
  .refine((p) => p.goMaxGapPct < p.cautionMaxGapPct, { message: "goMaxGapPct must be below cautionMaxGapPct" });
export type Policy = z.infer<typeof PolicySchema>;

export function parsePolicy(raw: unknown): Policy {
  return PolicySchema.parse(raw);
}

export const DEFAULT_POLICY: Policy = parsePolicy(defaultPolicyJson);

export type GateCode =
  | "NO_QUOTE"
  | "QUOTE_ERROR"
  | "QUOTE_STALE"
  | "SIZE_OVER_CAP"
  | "MARKET_PAUSED"
  | "ASSET_NOT_OPEN"
  | "GAP_TOO_WIDE"
  | "GAP_WIDE"
  | "GAP_OK"
  | "DISPLAY_MISMATCH"
  | "SPREAD_AT_BASE"
  | "IMPACT_AT_SIZE"
  | "NO_REFERENCE"
  | "NO_REFERENCE_DISAGREE"
  | "OFF_HOURS"
  | "STATUS_MISSING";

export type Severity = "block" | "caution" | "info";

export interface GateReason {
  code: GateCode;
  severity: Severity;
  message: string;
}

export interface VenueInput {
  row: MatrixRow;
  /** Quote at the trade size. */
  quote?: ExecQuote | null;
  /** Extra sizes for the impact rules (e.g. $100, $500). */
  ladder?: ExecQuote[];
}

export interface GateContext {
  session: SessionName | null;
  now: number;
  /** (max - min) / min of fill per share across the ticker's quotable venues; set by evaluateTicker. */
  venueDisagreementPct?: number | null;
}

export interface VenueVerdict {
  symbol: string;
  platform: Platform;
  verdict: Verdict;
  reasons: GateReason[];
  fillPerShare: number | null;
  executableGapPct: number | null;
  displayedGapPct: number | null;
  impactPct: Record<number, number | null>;
  quote: ExecQuote | null;
}

export interface TickerVerdict {
  ticker: string;
  reference: number | null;
  session: SessionName | null;
  venues: VenueVerdict[];
  bestVenue: VenueVerdict | null;
}

const p2 = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const lim = (n: number) => `${(n * 100).toFixed(2)}%`;
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function worst(a: Verdict, b: Verdict): Verdict {
  return RANK[a] >= RANK[b] ? a : b;
}

const verdictOf = (reasons: GateReason[]): Verdict =>
  reasons.some((r) => r.severity === "block") ? "BLOCK" : reasons.some((r) => r.severity === "caution") ? "CAUTION" : "GO";

/** Pure: the same inputs always give the same verdict. The worst rule wins. */
export function evaluateVenue(input: VenueInput, ctx: GateContext, policy: Policy = DEFAULT_POLICY): VenueVerdict {
  const { row } = input;
  const q = input.quote ?? null;
  const reasons: GateReason[] = [];
  const add = (code: GateCode, severity: Severity, message: string) => reasons.push({ code, severity, message });
  const ok: QuoteOk | null = q?.ok ? q : null;
  const sell = q?.side === "sell";
  const impactPct = ok && !sell ? ladderImpact([ok, ...(input.ladder ?? [])]) : {};

  if (!q) add("NO_QUOTE", "block", "No executable quote was fetched for this venue.");
  else if (!q.ok) add("QUOTE_ERROR", "block", `Quote failed: ${QUOTE_REASON_TEXT[q.reason]} (${q.code ?? "no code"}).`);

  if (q) {
    const ageSec = (ctx.now - q.ts) / 1000;
    if (ageSec > policy.quoteMaxAgeSec) add("QUOTE_STALE", "block", `Quote is ${Math.round(ageSec)}s old; the limit is ${policy.quoteMaxAgeSec}s.`);
    if (q.usd > policy.maxTradeUsd) add("SIZE_OVER_CAP", "block", `Size ${money(q.usd)} is over the ${money(policy.maxTradeUsd)} per-trade cap.`);
  }

  if (ctx.session === "pause") add("MARKET_PAUSED", "block", "US trading is paused for tokenized stocks.");
  const st = row.assetStatus;
  if (st?.reasonCode === "ASSET_PAUSED" || st?.open === false) {
    add("ASSET_NOT_OPEN", "block", `The venue reports the asset is not tradable (${st.reasonCode ?? "closed"}).`);
  }

  if (ok) {
    const ref = row.reference;
    if (ref === null) {
      const d = ctx.venueDisagreementPct;
      if (d !== null && d !== undefined && d > policy.maxVenueDisagreementPct) {
        add("NO_REFERENCE_DISAGREE", "block", `No independent stock price, and venues disagree by ${lim(d)} (limit ${lim(policy.maxVenueDisagreementPct)}).`);
      } else {
        add("NO_REFERENCE", "caution", "No independent stock price to check the fill against.");
      }
    } else {
      const gap = (ok.fillPerShare - ref) / ref;
      const vs = `${money(ok.fillPerShare)} per share vs the stock at ${money(ref)}`;
      const lead = sell ? `You receive ${p2(gap)} vs the stock` : `Fill is ${p2(gap)} off the stock`;
      if (Math.abs(gap) > policy.cautionMaxGapPct) add("GAP_TOO_WIDE", "block", `${lead} (${vs}); the limit is ±${lim(policy.cautionMaxGapPct)}.`);
      else if (Math.abs(gap) > policy.goMaxGapPct) add("GAP_WIDE", "caution", `${lead} (${vs}); GO needs ±${lim(policy.goMaxGapPct)}.`);
      else add("GAP_OK", "info", `${lead} (${vs}).`);

      if (row.displayedGapPct !== null) {
        const diff = Math.abs(row.displayedGapPct - gap);
        if (diff > policy.maxDisplayedVsExecutablePct) {
          add("DISPLAY_MISMATCH", "block", `Displayed gap ${p2(row.displayedGapPct)} vs executable ${p2(gap)}: the displayed price is not what you would get.`);
        }
      }
    }

    if (row.perShare !== null && row.perShare > 0) {
      const spread = sell ? 1 - ok.fillPerShare / row.perShare : ok.fillPerShare / row.perShare - 1;
      if (spread > policy.maxSpreadAtBasePct) {
        add(
          "SPREAD_AT_BASE",
          "block",
          sell
            ? `Selling ${money(ok.usd)} you receive ${lim(spread)} under the venue's displayed price (limit ${lim(policy.maxSpreadAtBasePct)}).`
            : `At ${money(ok.usd)} you pay ${p2(spread)} over the venue's displayed price (limit ${lim(policy.maxSpreadAtBasePct)}).`,
        );
      }
    }

    const impact = impactPct[policy.impactCautionUsd];
    if (impact !== null && impact !== undefined && impact > policy.impactCautionPct) {
      add("IMPACT_AT_SIZE", "caution", `At ${money(policy.impactCautionUsd)} the per-share cost rises ${p2(impact)} vs ${money(ok.usd)} (limit ${lim(policy.impactCautionPct)}).`);
    }
  }

  if (ctx.session !== "regular" && RANK[verdictOf(reasons)] < RANK[policy.offHoursMaxVerdict]) {
    const sev: Severity = policy.offHoursMaxVerdict === "BLOCK" ? "block" : "caution";
    add("OFF_HOURS", sev, `Outside the US regular session (${ctx.session ?? "unknown"}): liquidity is thinner and quotes move faster.`);
  }

  if (row.flags.includes("STATUS_MISSING")) add("STATUS_MISSING", "info", "This venue publishes no session status; the US market session is used instead.");

  const gap = ok && row.reference !== null ? (ok.fillPerShare - row.reference) / row.reference : null;
  return {
    symbol: row.symbol,
    platform: row.platform,
    verdict: verdictOf(reasons),
    reasons,
    fillPerShare: ok?.fillPerShare ?? null,
    executableGapPct: gap,
    displayedGapPct: row.displayedGapPct,
    impactPct,
    quote: q,
  };
}

export function venueDisagreement(quotes: Array<ExecQuote | null | undefined>): number | null {
  const fills = quotes.filter((q): q is QuoteOk => !!q?.ok).map((q) => q.fillPerShare);
  if (fills.length < 2) return null;
  const min = Math.min(...fills);
  return (Math.max(...fills) - min) / min;
}

/** Best venue: GO before CAUTION, then the lowest price for a buy or the highest for a sell. BLOCK venues are never chosen. */
export function pickBest(venues: VenueVerdict[], side: Side = "buy"): VenueVerdict | null {
  const dir = side === "sell" ? -1 : 1;
  return (
    venues
      .filter((v) => v.verdict !== "BLOCK" && v.fillPerShare !== null)
      .sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || dir * (a.fillPerShare! - b.fillPerShare!))[0] ?? null
  );
}

export function evaluateTicker(inputs: VenueInput[], ctx: Omit<GateContext, "venueDisagreementPct">, policy: Policy = DEFAULT_POLICY): TickerVerdict {
  const disagreement = venueDisagreement(inputs.map((i) => i.quote));
  const venues = inputs.map((i) => evaluateVenue(i, { ...ctx, venueDisagreementPct: disagreement }, policy));
  const side: Side = inputs.some((i) => i.quote?.side === "sell") ? "sell" : "buy";
  return {
    ticker: inputs[0]?.row.ticker ?? "",
    reference: inputs[0]?.row.reference ?? null,
    session: ctx.session,
    venues,
    bestVenue: pickBest(venues, side),
  };
}
