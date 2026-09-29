import Link from "next/link";
import { RadarTable } from "@/components/RadarTable";
import { SessionBadge } from "@/components/SessionBadge";
import { VerdictChip } from "@/components/VerdictChip";
import { SESSION_LABEL, pct, utc } from "@/lib/format";
import { countTraps, pickExamples, toRadarRows, type Example } from "@/lib/radar";
import { SNAPSHOT } from "@/lib/snapshot";

function ExampleCard({ title, ex, story }: { title: string; ex: Example; story: string }) {
  return (
    <Link href={`/t/${ex.ticker}`} className="block rounded-lg border border-line bg-panel p-4 transition hover:border-accent">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-muted">{title}</span>
        <VerdictChip verdict="BLOCK" />
      </div>
      <div className="font-mono text-lg font-semibold">{ex.symbol}</div>
      <p className="mt-1 text-sm text-muted">{story}</p>
      <p className="mt-2 line-clamp-2 text-xs text-block">{ex.reason}</p>
      {ex.best && (
        <p className="mt-2 text-sm">
          Safe instead: <span className="font-mono font-semibold text-go">{ex.best.symbol}</span> at {pct(ex.best.executableGapPct)} vs the stock{" "}
          <VerdictChip verdict="GO" small />
        </p>
      )}
      <span className="mt-3 inline-block text-xs text-accent">Open the Truth Card →</span>
    </Link>
  );
}

export default function RadarPage() {
  const s = SNAPSHOT;
  const rows = toRadarRows(s);
  const { mirage, thinPool } = pickExamples(s);
  const traps = countTraps(s);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          The same stock trades on BNB Chain as three tokens. <span className="text-accent">Which prices can you actually get?</span>
        </h1>
        <p className="max-w-3xl text-muted">
          Ondo (<span className="font-mono">NVDAon</span>), xStocks (<span className="font-mono">NVDAx</span>) and bStocks (<span className="font-mono">NVDAB</span>) each display a price. Gaps between
          them look like free money, but most are stale prices or pools too thin to fill. This desk quotes a real $25 fill for every venue and gates it{" "}
          <VerdictChip verdict="GO" small /> <VerdictChip verdict="CAUTION" small /> <VerdictChip verdict="BLOCK" small />, with the reason in plain English.
        </p>
        <SessionBadge />
      </section>

      {(mirage || thinPool) && (
        <section className="grid gap-3 md:grid-cols-2">
          {mirage && (
            <ExampleCard
              title="Displayed discount you cannot buy"
              ex={mirage}
              story={`Displays ${pct(mirage.displayedGapPct)} vs ${mirage.ticker}. It looks cheap; a real $25 order finds ${mirage.executableGapPct === null ? "no liquidity at all" : `a fill at ${pct(mirage.executableGapPct)}`}.`}
            />
          )}
          {thinPool && (
            <ExampleCard
              title="Normal-looking price, terrible fill"
              ex={thinPool}
              story={`Displays ${pct(thinPool.displayedGapPct)} vs ${thinPool.ticker}, but $25 routes through a thin pool and fills at ${pct(thinPool.executableGapPct, 0)}.`}
            />
          )}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-lg font-semibold">Radar: every BSC tokenized stock</h2>
          <p className="text-xs text-muted">
            $25 sweep at {utc(s.builtAt)} ({s.session ? SESSION_LABEL[s.session.session] : "session unknown"}). Open a stock for live quotes.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <Stat label="Venues quoted" value={String(s.summary.venues)} />
          <Stat label="GO" value={String(s.summary.go)} className="text-go" />
          <Stat label="BLOCK" value={String(s.summary.block)} className="text-block" />
          <Stat label="3%+ displayed gaps blocked" value={String(traps)} className="text-caution" />
        </div>
        <RadarTable rows={rows} />
      </section>
    </div>
  );
}

function Stat({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2">
      <div className={`num text-xl font-semibold ${className}`}>{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
