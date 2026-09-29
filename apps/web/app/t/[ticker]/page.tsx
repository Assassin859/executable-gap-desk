import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExecutePanel } from "@/components/ExecutePanel";
import { LiveCheckPanel } from "@/components/LiveCheck";
import { VenueCard } from "@/components/VenueCard";
import { VerdictChip } from "@/components/VerdictChip";
import { PLATFORM_LABEL, SESSION_LABEL, pct, usd, utc } from "@/lib/format";
import { SNAPSHOT, snapshotTicker } from "@/lib/snapshot";

type Params = { params: Promise<{ ticker: string }> };

export function generateStaticParams() {
  return SNAPSHOT.tickers.map((t) => ({ ticker: t.ticker }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { ticker } = await params;
  return { title: `${ticker.toUpperCase()} Truth Card · Executable Gap Desk` };
}

export default async function TruthCardPage({ params }: Params) {
  const { ticker } = await params;
  const t = snapshotTicker(ticker);
  if (!t) notFound();
  const best = t.best ? t.venues.find((v) => v.symbol === t.best) : undefined;
  const loudest = [...t.venues].filter((v) => v.displayedGapPct !== null).sort((a, b) => Math.abs(b.displayedGapPct!) - Math.abs(a.displayedGapPct!))[0];
  const executeEnabled = process.env.EXECUTE_MODE === "local";

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-muted hover:text-white">
        ← Radar
      </Link>

      <section className="space-y-2">
        <h1 className="flex flex-wrap items-baseline gap-3 text-3xl font-semibold tracking-tight">
          {t.ticker}
          <span className="num text-lg font-normal text-muted">{t.reference ? `stock ${usd(t.reference)}` : "no stock price"}</span>
        </h1>
        <p className="max-w-3xl text-muted">
          {t.venues.length} BSC {t.venues.length === 1 ? "venue" : "venues"}: {t.venues.map((v) => `${v.symbol} (${PLATFORM_LABEL[v.platform]})`).join(", ")}.{" "}
          {loudest && Math.abs(loudest.displayedGapPct ?? 0) >= 0.03 && (
            <>
              {loudest.symbol} displays {pct(loudest.displayedGapPct)} vs the stock{loudest.verdict === "BLOCK" ? ", and the gate blocks it." : "."}{" "}
            </>
          )}
          {best ? (
            <>
              The venue to use is <span className="font-mono font-semibold text-white">{best.symbol}</span> <VerdictChip verdict={best.verdict} small />, filling at {pct(best.executableGapPct)} vs the stock.
            </>
          ) : (
            <span className="text-block">No venue passed the gate.</span>
          )}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">
          $25 sweep <span className="text-sm font-normal text-muted">at {utc(SNAPSHOT.builtAt)} ({t.session ? SESSION_LABEL[t.session] : "session unknown"})</span>
        </h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {t.venues.map((v) => (
            <VenueCard key={v.symbol} v={v} best={v.symbol === t.best} reference={t.reference} />
          ))}
        </div>
      </section>

      <LiveCheckPanel ticker={t.ticker} />

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
