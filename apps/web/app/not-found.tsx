import Link from "next/link";
import { SNAPSHOT } from "@/lib/snapshot";

const SUGGESTED = ["NVDA", "AAPL", "TSLA", "MSTR", "COIN", "SPY"];

export default function NotFound() {
  const known = new Set(SNAPSHOT.tickers.map((t) => t.ticker));
  const suggestions = SUGGESTED.filter((t) => known.has(t));

  return (
    <div className="mx-auto max-w-xl space-y-4 py-12 text-center">
      <p className="font-mono text-sm text-muted">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">No BSC tokenized stock here</h1>
      <p className="text-muted">
        The desk covers the {SNAPSHOT.tickers.length} US stocks that trade on BNB Smart Chain as Ondo, xStocks or bStocks tokens. Truth Cards are addressed by the underlying
        ticker, like <span className="font-mono">/t/NVDA</span>, not the token symbol.
      </p>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {suggestions.map((t) => (
            <Link key={t} href={`/t/${t}`} className="rounded-md border border-line bg-panel px-3 py-1.5 font-mono text-sm hover:border-accent">
              {t}
            </Link>
          ))}
        </div>
      )}
      <Link href="/" className="inline-block text-sm text-accent underline">
        Search the radar
      </Link>
    </div>
  );
}
