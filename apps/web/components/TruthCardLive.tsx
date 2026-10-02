"use client";

import { useCallback, useState, type ReactNode } from "react";
import { usd, utc } from "@/lib/format";
import { LiveCheckPanel, type LiveCheck } from "./LiveCheck";

export interface HeaderPrice {
  price: number | null;
  at: number;
  source: "live" | "sweep";
}

/**
 * Owns the live check so the header's stock price follows it, and folds the last full sweep away once live
 * quotes are in, so two different prices for the same stock never sit side by side.
 */
export function TruthCardLive({
  ticker,
  venues,
  initial,
  intro,
  sweepTitle,
  children,
}: {
  ticker: string;
  venues: number;
  initial: HeaderPrice;
  intro: ReactNode;
  sweepTitle: ReactNode;
  children: ReactNode;
}) {
  const [price, setPrice] = useState<HeaderPrice>(initial);
  const [live, setLive] = useState(false);

  const onData = useCallback((c: LiveCheck) => {
    setLive(true);
    if (c.ticker.reference) setPrice({ price: c.ticker.reference, at: c.checkedAt, source: "live" });
  }, []);

  return (
    <>
      <section className="space-y-2">
        <h1 className="flex flex-wrap items-baseline gap-3 text-3xl font-semibold tracking-tight">
          {ticker}
          <span className="num text-lg font-normal text-muted">{price.price ? `stock ${usd(price.price)}` : "no stock price"}</span>
          {price.price && (
            <span className="text-xs font-normal text-muted">{price.source === "live" ? `as of ${utc(price.at)}` : `from the sweep at ${utc(price.at)}`}</span>
          )}
        </h1>
        {intro}
      </section>

      <LiveCheckPanel ticker={ticker} venues={venues} onData={onData} />

      <details open={!live} className="group space-y-3">
        <summary className="cursor-pointer list-none font-semibold">
          <span className="mr-1 inline-block text-muted transition group-open:rotate-90">›</span>
          {sweepTitle}
          {live && <span className="ml-2 text-sm font-normal text-muted">(older prices; the live check above replaces them)</span>}
        </summary>
        <div className="mt-3">{children}</div>
      </details>
    </>
  );
}
