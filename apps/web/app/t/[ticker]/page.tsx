import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ExecutePanel } from "@/components/ExecutePanel";
import { TruthCardLive, type HeaderPrice } from "@/components/TruthCardLive";
import { VenueCard } from "@/components/VenueCard";
import { VerdictChip } from "@/components/VerdictChip";
import { PLATFORM_LABEL, SESSION_LABEL, pct, utc } from "@/lib/format";
import { liveReference } from "@/lib/server";
import { SNAPSHOT, snapshotTicker } from "@/lib/snapshot";

type Params = { params: Promise<{ ticker: string }> };

// Rendered on first request and re-rendered at most every 5 minutes, so the header's stock price stays fresh
// without 500+ price calls at build time.
export const revalidate = 300;

export function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { ticker } = await params;
  const t = snapshotTicker(ticker);
  return { title: t ? `${t.ticker} Truth Card · Executable Gap Desk` : "Not found · Executable Gap Desk" };
}

function tickerForSymbol(symbol: string): string | undefined {
  const s = symbol.toUpperCase();
  return SNAPSHOT.tickers.find((t) => t.venues.some((v) => v.symbol.toUpperCase() === s))?.ticker;
}

export default async function TruthCardPage({ params }: Params) {
  const { ticker } = await params;
  const t = snapshotTicker(ticker);
  if (!t) {
    const owner = tickerForSymbol(decodeURIComponent(ticker));
    if (owner) redirect(`/t/${owner}`);
    notFound();
  }
  const best = t.best ? t.venues.find((v) => v.symbol === t.best) : undefined;
  const loudest = [...t.venues].filter((v) => v.displayedGapPct !== null).sort((a, b) => Math.abs(b.displayedGapPct!) - Math.abs(a.displayedGapPct!))[0];
  const executeEnabled = process.env.EXECUTE_MODE === "local";
  const live = await liveReference(t);
  const initial: HeaderPrice = live ? { price: live.price, at: live.at, source: "live" } : { price: t.reference, at: SNAPSHOT.builtAt, source: "sweep" };

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-muted hover:text-white">
        ← Radar
      </Link>

      <TruthCardLive
        ticker={t.ticker}
        venues={t.venues.length}
        initial={initial}
        intro={
          <p className="max-w-3xl text-muted">
            {t.venues.length} BSC {t.venues.length === 1 ? "venue" : "venues"}: {t.venues.map((v) => `${v.symbol} (${PLATFORM_LABEL[v.platform]})`).join(", ")}. In the last full sweep,{" "}
            {loudest && Math.abs(loudest.displayedGapPct ?? 0) >= 0.03 && (
              <>
                {loudest.symbol} displayed {pct(loudest.displayedGapPct)} vs the stock{loudest.verdict === "BLOCK" ? " and the gate blocked it" : ""};{" "}
              </>
            )}
            {best ? (
              <>
                the venue to use was <span className="font-mono font-semibold text-white">{best.symbol}</span> <VerdictChip verdict={best.verdict} small />, filling at {pct(best.executableGapPct)} vs the stock.
              </>
            ) : (
              <span className="text-block">no venue passed the gate.</span>
            )}
          </p>
        }
        sweepTitle={
          <>
            Last full sweep <span className="text-sm font-normal text-muted">at {utc(SNAPSHOT.builtAt)} ({t.session ? SESSION_LABEL[t.session] : "session unknown"}), $25 per venue</span>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {t.venues.map((v) => (
            <VenueCard key={v.symbol} v={v} best={v.symbol === t.best} reference={t.reference} />
          ))}
        </div>
      </TruthCardLive>

      {executeEnabled && <ExecutePanel venues={t.venues.map((v) => ({ symbol: v.symbol, platform: v.platform }))} defaultSymbol={best?.symbol ?? null} />}

      <p className="text-xs text-muted">
        How the gate decides: the worst rule wins. A fill within 0.75% of the stock is GO, within 1.5% CAUTION, otherwise BLOCK; a failed quote, a displayed price that disagrees with the fill by more
        than 3%, or a fill more than 2% above the displayed price also blocks; outside US regular hours nothing is better than CAUTION.{" "}
        <a className="underline" href="https://github.com/Assassin859/executable-gap-desk#gate-policy">
          Full policy
        </a>
      </p>
    </div>
  );
}
