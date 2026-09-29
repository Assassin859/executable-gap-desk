import type { PublicVenue } from "@gapdesk/core";
import { PLATFORM_LABEL, pct, usd } from "@/lib/format";
import { VerdictChip } from "./VerdictChip";

const SEVERITY_DOT = { block: "bg-block", caution: "bg-caution", info: "bg-muted" } as const;

export function VenueCard({ v, best, reference }: { v: PublicVenue; best: boolean; reference: number | null }) {
  const q = v.quote;
  const baseUsd = q?.usd ?? 25;
  const sizes = Object.entries(v.impactPct).filter(([size, x]) => x !== null && Number(size) !== baseUsd);
  return (
    <div className={`rounded-lg border bg-panel p-4 ${best ? "border-go/60" : "border-line"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-lg font-semibold">{v.symbol}</span>
          <span className="text-sm text-muted">{PLATFORM_LABEL[v.platform]}</span>
          {best && <span className="rounded bg-go/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-go">best venue</span>}
        </div>
        <VerdictChip verdict={v.verdict} />
      </div>

      <dl className="num mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-muted">Displayed per share</dt>
          <dd>
            {usd(v.displayedPerShare)} <span className="text-muted">({pct(v.displayedGapPct)})</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Real fill per share at ${q?.usd ?? 25}</dt>
          <dd className="font-semibold">
            {v.fillPerShare === null ? <span className="text-block">no fill</span> : usd(v.fillPerShare)}{" "}
            {v.executableGapPct !== null && <span className={Math.abs(v.executableGapPct) > 0.015 ? "text-block" : "text-muted"}>({pct(v.executableGapPct)})</span>}
          </dd>
        </div>
        {sizes.length > 0 && (
          <div className="col-span-2">
            <dt className="text-xs text-muted">Price impact vs the $25 fill</dt>
            <dd className="flex flex-wrap gap-3">
              {sizes.map(([size, x]) => (
                <span key={size}>
                  ${size}: {pct(x)}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-3 text-xs text-muted">
        {q?.ok ? (
          <>
            {q.mode} via {q.vendor ?? "unknown vendor"}
            {q.route.length > 0 && <span className="font-mono"> · {q.route.join(" › ")}</span>}
          </>
        ) : q ? (
          <span className="text-block">
            Quote failed{q.code ? ` (${q.code})` : ""}: {q.message}
          </span>
        ) : (
          "Not quoted"
        )}
        {reference === null && <span> · no stock price to compare against</span>}
      </div>

      <ul className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
        {v.reasons.map((r, i) => (
          <li key={i} className="flex gap-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[r.severity]}`} />
            <span className={r.severity === "info" ? "text-muted" : ""}>{r.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
