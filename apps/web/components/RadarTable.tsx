"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { PLATFORM_LABEL, pct, usd } from "@/lib/format";
import { filterRows, sortRows, type RadarRow, type SortKey } from "@/lib/radar";
import { VERDICT_TEXT, VerdictChip } from "./VerdictChip";

const COLUMNS: { key: SortKey; label: string; hint: string; className?: string }[] = [
  { key: "ticker", label: "Stock", hint: "Underlying US ticker" },
  { key: "venues", label: "Venues", hint: "BSC tokens for this stock, colored by verdict", className: "hidden md:table-cell" },
  { key: "displayed", label: "Displayed gap", hint: "Largest gap between a venue's displayed price and the stock" },
  { key: "executable", label: "Executable at $25", hint: "What a real $25 fill costs vs the stock, at the best safe venue" },
  { key: "verdict", label: "Verdict", hint: "Best verdict across the venues" },
];

export function RadarTable({ rows }: { rows: RadarRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "displayed", dir: "desc" });
  const [multiOnly, setMultiOnly] = useState(false);
  const [hideBlock, setHideBlock] = useState(false);
  const [query, setQuery] = useState("");

  const shown = useMemo(() => sortRows(filterRows(rows, { multiOnly, hideBlock, query }), sort.key, sort.dir), [rows, multiOnly, hideBlock, query, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "displayed" ? "desc" : "asc" }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search NVDA, MSTRx, AAPLon…"
          className="w-full rounded-md border border-line bg-panel px-3 py-2 outline-none placeholder:text-muted focus:border-accent sm:w-72"
        />
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={multiOnly} onChange={(e) => setMultiOnly(e.target.checked)} className="accent-accent" />
          Listed on 2+ platforms
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={hideBlock} onChange={(e) => setHideBlock(e.target.checked)} className="accent-accent" />
          Hide BLOCK
        </label>
        <span className="text-muted sm:ml-auto">
          {shown.length} of {rows.length} stocks
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} title={c.hint} className={`px-3 py-2 font-medium ${c.className ?? ""}`}>
                  <button onClick={() => toggleSort(c.key)} className="inline-flex items-center gap-1 hover:text-white">
                    {c.label}
                    <span className="text-[10px]">{sort.key === c.key ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((r) => (
              <tr key={r.ticker} className="hover:bg-panel/70">
                <td className="px-3 py-2">
                  <Link href={`/t/${r.ticker}`} className="font-semibold text-white underline-offset-2 hover:underline">
                    {r.ticker}
                  </Link>
                  <div className="num text-xs text-muted">{r.reference ? `stock ${usd(r.reference)}` : "no stock price"}</div>
                </td>
                <td className="hidden px-3 py-2 md:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {r.venues.map((v) => (
                      <span key={v.symbol} title={`${PLATFORM_LABEL[v.platform]}: ${v.verdict}`} className={`rounded bg-ink px-1.5 py-0.5 font-mono text-xs ring-1 ring-line ${VERDICT_TEXT[v.verdict]}`}>
                        {v.symbol}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="num px-3 py-2">
                  {r.loudest ? (
                    <>
                      <span className={Math.abs(r.loudest.displayedGapPct) >= 0.03 ? "font-semibold text-caution" : ""}>{pct(r.loudest.displayedGapPct)}</span>
                      <div className="font-mono text-xs text-muted">
                        {r.loudest.symbol}
                        {r.loudest.verdict === "BLOCK" && <span className="text-block"> · blocked</span>}
                      </div>
                    </>
                  ) : (
                    <span className="text-muted">n/a</span>
                  )}
                </td>
                <td className="num px-3 py-2">
                  {r.best ? (
                    <>
                      <span className="font-semibold">{pct(r.best.executableGapPct)}</span>
                      <div className="font-mono text-xs text-muted">
                        {r.best.symbol} · {usd(r.best.fillPerShare)}/sh
                      </div>
                    </>
                  ) : (
                    <span className="text-xs text-block" title={r.headline ?? undefined}>
                      no safe venue
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <VerdictChip verdict={r.verdict} />
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-muted">
                  No stocks match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
