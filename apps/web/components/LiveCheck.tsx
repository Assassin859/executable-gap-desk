"use client";

import type { PublicSession, PublicTicker } from "@gapdesk/core";
import { useCallback, useEffect, useState } from "react";
import { SESSION_LABEL, ago, pct } from "@/lib/format";
import { VenueCard } from "./VenueCard";
import { VerdictChip } from "./VerdictChip";

interface LiveCheck {
  checkedAt: number;
  ladder: boolean;
  session: PublicSession | null;
  ticker: PublicTicker;
}

export function LiveCheckPanel({ ticker }: { ticker: string }) {
  const [data, setData] = useState<LiveCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"base" | "ladder" | null>("base");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    async (ladder: boolean) => {
      setLoading(ladder ? "ladder" : "base");
      setError(null);
      try {
        const r = await fetch(`/api/check/${ticker}${ladder ? "?ladder=1" : ""}`);
        const body = (await r.json()) as LiveCheck & { error?: string };
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setData(body);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(null);
        setNow(Date.now());
      }
    },
    [ticker],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const t = data?.ticker;
  const best = t?.best ? t.venues.find((v) => v.symbol === t.best) : undefined;

  return (
    <section className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          Live now <span className="text-sm font-normal text-muted">(fresh aggregator quotes, gated)</span>
        </h2>
        <div className="flex gap-2 text-sm">
          <button onClick={() => load(false)} disabled={loading !== null} className="rounded-md border border-line px-3 py-1.5 hover:bg-line disabled:opacity-50">
            {loading === "base" ? "Quoting…" : "Re-quote $25"}
          </button>
          <button onClick={() => load(true)} disabled={loading !== null} className="rounded-md border border-line px-3 py-1.5 hover:bg-line disabled:opacity-50">
            {loading === "ladder" ? "Quoting $100 / $500…" : "Add $100 / $500"}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-caution">{error}</p>}
      {!data && !error && <p className="text-sm text-muted">Quoting every venue at $25…</p>}

      {data && t && (
        <>
          <p className="text-sm text-muted">
            Checked {ago(data.checkedAt, now)} · {data.session ? SESSION_LABEL[data.session.session] : "session unknown"}
            {data.session && data.session.session !== "regular" && " · outside regular hours the gate caps every verdict at CAUTION, so nothing is GO"}
          </p>
          <p className="text-sm">
            {best ? (
              <>
                Best venue right now: <span className="font-mono font-semibold">{best.symbol}</span> <VerdictChip verdict={best.verdict} small /> at {pct(best.executableGapPct)} vs the stock.
              </>
            ) : (
              <span className="text-block">No venue is safe to trade right now.</span>
            )}
          </p>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {t.venues.map((v) => (
              <VenueCard key={v.symbol} v={v} best={v.symbol === t.best} reference={t.reference} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
