"use client";

import type { ExecReceipt, Platform } from "@gapdesk/core";
import { useState } from "react";
import { PLATFORM_LABEL, pct, usd } from "@/lib/format";

const SIZES = [1, 2, 6];
const ONDO_MIN_USD = 6;

interface ExecResponse {
  receipt?: ExecReceipt;
  path?: string | null;
  steps?: { step: string; detail?: string }[];
  error?: string;
}

const OUTCOME_STYLE: Record<string, string> = {
  FILLED: "text-go",
  SIMULATED: "text-accent",
  REFUSED: "text-block",
  FAILED: "text-block",
  PENDING: "text-caution",
  PLACED: "text-go",
  CANCELED: "text-accent",
};

type Side = "buy" | "sell";
type Route = "market-order" | "contract-call";
const ALL = "all" as const;

export function ExecutePanel({ venues, defaultSymbol }: { venues: { symbol: string; platform: Platform }[]; defaultSymbol: string | null }) {
  const [symbol, setSymbol] = useState(defaultSymbol ?? venues[0]?.symbol ?? "");
  const [side, setSide] = useState<Side>("buy");
  const [via, setVia] = useState<Route>("market-order");
  const [size, setSize] = useState<number | typeof ALL>(1);
  const [busy, setBusy] = useState<"dry" | "live" | null>(null);
  const [result, setResult] = useState<ExecResponse | null>(null);
  const [typed, setTyped] = useState("");
  const platform = venues.find((v) => v.symbol === symbol)?.platform;
  const route: Route = side === "sell" ? "market-order" : via;
  const sizeOk = size === ALL ? side === "sell" : !(platform === "ondo" && size < ONDO_MIN_USD);
  const key = `${symbol}|${side}|${route}|${size}`;
  const [simKey, setSimKey] = useState<string | null>(null);
  const simulated = result?.receipt?.outcome === "SIMULATED" && simKey === key;

  function pickSide(s: Side) {
    setSide(s);
    if (s === "buy" && size === ALL) setSize(1);
  }

  async function run(live: boolean) {
    setBusy(live ? "live" : "dry");
    if (!live) setResult(null);
    try {
      const r = await fetch("/api/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          side,
          via: route,
          ...(size === ALL ? { all: true } : { usd: size }),
          live,
          confirm: live ? typed.trim().toLowerCase() : undefined,
        }),
      });
      if (!live) setSimKey(key);
      setResult((await r.json()) as ExecResponse);
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      setTyped("");
    }
  }

  const rc = result?.receipt;
  const txs = rc
    ? [rc.approval?.txHash ? { label: "Approval", url: rc.approval.bscscan } : null, rc.swap?.txHash ? { label: rc.via === "market-order" ? "Market order" : "Swap", url: rc.swap.bscscan } : null].filter(Boolean)
    : [];

  return (
    <section className="space-y-4 rounded-xl border border-line bg-panel p-4">
      <div>
        <h2 className="font-semibold">Execute (local only)</h2>
        <p className="text-sm text-muted">
          Trades with your Binance Agentic Wallet through <span className="font-mono">baw</span> on this machine. Buys and sells are gated (GO only); a market order also has to match the
          gated quote within 0.5%, and a contract call is simulated with an exact-amount approval. Every run writes a receipt. A dry run never sends anything.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex overflow-hidden rounded-md border border-line" role="group" aria-label="Side">
          {(["buy", "sell"] as const).map((s) => (
            <button key={s} onClick={() => pickSide(s)} className={`px-3 py-2 capitalize ${side === s ? (s === "buy" ? "bg-go/15 text-go" : "bg-block/15 text-block") : ""}`}>
              {s}
            </button>
          ))}
        </div>
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="rounded-md border border-line bg-ink px-3 py-2">
          {venues.map((v) => (
            <option key={v.symbol} value={v.symbol}>
              {v.symbol} ({PLATFORM_LABEL[v.platform]})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2">
          <span className="text-muted">Route</span>
          <select value={route} disabled={side === "sell"} onChange={(e) => setVia(e.target.value as Route)} className="rounded-md border border-line bg-ink px-3 py-2 disabled:opacity-60" title={side === "sell" ? "Sells use the Agentic Wallet market order" : undefined}>
            <option value="market-order">Agentic Wallet market order</option>
            <option value="contract-call">Contract call (router tx)</option>
          </select>
        </label>
        <div className="flex gap-1">
          {[...SIZES, ...(side === "sell" ? [ALL] : [])].map((s) => {
            const disabled = s !== ALL && platform === "ondo" && s < ONDO_MIN_USD;
            return (
              <button
                key={String(s)}
                disabled={disabled}
                title={disabled ? "Ondo orders must be over $5" : s === ALL ? "Sell the whole on-chain balance" : undefined}
                onClick={() => setSize(s)}
                className={`rounded-md border px-3 py-2 ${size === s ? "border-accent text-accent" : "border-line"} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {s === ALL ? "All" : `$${s}`}
              </button>
            );
          })}
        </div>
        <button onClick={() => run(false)} disabled={busy !== null || !sizeOk} className="rounded-md bg-accent px-4 py-2 font-semibold text-ink disabled:opacity-50">
          {busy === "dry" ? "Checking…" : "Dry run"}
        </button>
      </div>

      {simulated && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-caution/40 bg-caution/5 p-3 text-sm">
          <span>
            Dry run passed. To {side} {size === ALL ? `all ${symbol}` : `${usd(size)} of ${symbol}`} on BSC mainnet{route === "market-order" ? " with an Agentic Wallet market order (it executes immediately)" : ""}, type{" "}
            <span className="font-mono font-semibold">yes</span>:
          </span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} className="w-20 rounded-md border border-line bg-ink px-2 py-1.5 font-mono" aria-label="Type yes to confirm" />
          <button onClick={() => run(true)} disabled={busy !== null || typed.trim().toLowerCase() !== "yes"} className="rounded-md bg-block px-4 py-2 font-semibold text-white disabled:opacity-40">
            {busy === "live" ? "Signing…" : "Sign and broadcast"}
          </button>
        </div>
      )}

      {result?.error && <p className="text-sm text-block">{result.error}</p>}

      {rc && (
        <div className="space-y-2 rounded-lg border border-line bg-ink p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`font-semibold ${OUTCOME_STYLE[rc.outcome] ?? ""}`}>{rc.outcome === "SIMULATED" ? "SIMULATED, NOT BROADCAST" : rc.outcome}</span>
            <span className="font-mono">
              {rc.side === "sell" ? "SELL" : "BUY"} {rc.symbol} {usd(rc.usd)}
            </span>
            <span className="text-muted">
              ({rc.mode}
              {rc.via ? `, ${rc.via}` : ""})
            </span>
          </div>
          {rc.refusal && (
            <p className="text-block">
              {rc.refusal.code}: {rc.refusal.message}
            </p>
          )}
          {rc.walletQuote && (
            <p className="text-muted">
              Wallet quote {usd(rc.walletQuote.fillPerShare)}/share: {pct(rc.walletQuote.deviationPct)} vs the gated quote, {pct(rc.walletQuote.gapPct)} vs the stock
            </p>
          )}
          {rc.order && <p className="font-mono text-xs text-muted">Order {rc.order.id} · {rc.order.status}</p>}
          {rc.fill && rc.fill.fillPerShare !== null && (
            <p>
              {rc.side === "sell" ? `Sold ${rc.fill.tokensOut} for ${usd(rc.fill.usdReceived ?? null)}` : `Filled ${rc.fill.tokensOut}`} at {usd(rc.fill.fillPerShare)}/share (quoted {usd(rc.fill.quotedFillPerShare)},{" "}
              {pct(rc.fill.realizedVsQuotedPct)} vs quote, {pct(rc.fill.realizedGapPct)} vs the stock)
            </p>
          )}
          {txs.map((t) => t && t.url && (
            <a key={t.label} href={t.url} target="_blank" rel="noreferrer" className="block text-accent underline">
              {t.label} on BscScan
            </a>
          ))}
          {result?.steps && (
            <ol className="list-inside list-decimal space-y-0.5 text-xs text-muted">
              {result.steps.map((s, i) => (
                <li key={i}>
                  {s.step}
                  {s.detail ? ` · ${s.detail}` : ""}
                </li>
              ))}
            </ol>
          )}
          {result?.path && <p className="font-mono text-xs text-muted">{result.path}</p>}
        </div>
      )}
    </section>
  );
}
