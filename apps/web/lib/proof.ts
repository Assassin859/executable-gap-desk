import type { ExecReceipt, Outcome, Verdict } from "@gapdesk/core";

export interface LedgerTx {
  label: string;
  hash: string;
  url: string;
}

export interface LedgerRow {
  id: string;
  createdAt: string;
  what: string;
  kind: ExecReceipt["kind"];
  side: "buy" | "sell" | null;
  via: ExecReceipt["via"] | null;
  mode: ExecReceipt["mode"];
  outcome: Outcome;
  usd: number;
  verdict: Verdict | null;
  quotedPerShare: number | null;
  filledPerShare: number | null;
  realizedVsQuotedPct: number | null;
  realizedGapPct: number | null;
  tokensOut: number | null;
  orderId: string | null;
  triggerPriceUsd: number | null;
  refusal: { code: string; message: string } | null;
  txs: LedgerTx[];
}

function describe(r: ExecReceipt): string {
  if (r.kind === "funding") return r.via === "market-order" ? `Convert ${r.symbol.replace("-", " to ")} (wallet market order)` : "BNB to USDT funding";
  if (r.kind === "limit") return r.symbol.startsWith("cancel-") || r.outcome === "CANCELED" ? `Cancel limit buy ${r.symbol.replace(/^cancel-/, "")}` : `Limit buy ${r.symbol}`;
  const side = r.side === "sell" ? "Sell" : "Buy";
  return `${side} ${r.symbol}${r.via === "market-order" ? " (wallet market order)" : ""}`;
}

export function toLedgerRow(r: ExecReceipt): LedgerRow {
  const txs: LedgerTx[] = [];
  if (r.approval?.txHash && r.approval.bscscan) txs.push({ label: "approval", hash: r.approval.txHash, url: r.approval.bscscan });
  if (r.swap?.txHash && r.swap.bscscan) {
    const label = r.kind === "funding" ? "funding swap" : r.via === "market-order" ? "market order" : "swap";
    txs.push({ label, hash: r.swap.txHash, url: r.swap.bscscan });
  }
  const perShare = r.kind !== "funding";
  return {
    id: r.id,
    createdAt: r.createdAt,
    what: describe(r),
    kind: r.kind,
    side: r.kind === "funding" ? null : (r.side ?? "buy"),
    via: r.via ?? null,
    mode: r.mode,
    outcome: r.outcome,
    usd: r.usd,
    verdict: r.gate?.verdict ?? null,
    quotedPerShare: perShare ? (r.fill?.quotedFillPerShare ?? r.quote?.fillPerShare ?? null) : null,
    filledPerShare: perShare ? (r.fill?.fillPerShare ?? null) : null,
    realizedVsQuotedPct: r.fill?.realizedVsQuotedPct ?? null,
    realizedGapPct: perShare ? (r.fill?.realizedGapPct ?? null) : null,
    tokensOut: r.fill?.tokensOut ?? null,
    orderId: r.order?.id ?? null,
    triggerPriceUsd: r.limit?.triggerPriceUsd ?? null,
    refusal: r.refusal ? { code: r.refusal.code, message: r.refusal.message } : null,
    txs,
  };
}

export interface Ledger {
  /** Runs that put a transaction on chain (fills, and approvals that went through before a refusal). */
  onChain: LedgerRow[];
  /** Live limit-order attempts through the Agentic Wallet: placed, cancelled, or turned down by the wallet (no tx until one triggers). */
  limits: LedgerRow[];
  /** Refusals, which stop before anything is signed. */
  refusals: LedgerRow[];
  dryRuns: number;
}

export function buildLedger(receipts: ExecReceipt[]): Ledger {
  const rows = receipts.map(toLedgerRow).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    onChain: rows.filter((r) => r.txs.length > 0),
    limits: rows.filter((r) => r.kind === "limit" && r.mode === "live" && r.txs.length === 0 && (r.outcome !== "REFUSED" || r.refusal?.code === "WALLET_REJECTED")),
    refusals: rows.filter((r) => r.outcome === "REFUSED" && r.txs.length === 0 && !(r.kind === "limit" && r.refusal?.code === "WALLET_REJECTED")),
    dryRuns: rows.filter((r) => r.outcome === "SIMULATED").length,
  };
}
