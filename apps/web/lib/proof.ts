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
  mode: ExecReceipt["mode"];
  outcome: Outcome;
  usd: number;
  verdict: Verdict | null;
  quotedPerShare: number | null;
  filledPerShare: number | null;
  realizedVsQuotedPct: number | null;
  realizedGapPct: number | null;
  tokensOut: number | null;
  refusal: { code: string; message: string } | null;
  txs: LedgerTx[];
}

export function toLedgerRow(r: ExecReceipt): LedgerRow {
  const txs: LedgerTx[] = [];
  if (r.approval?.txHash && r.approval.bscscan) txs.push({ label: "approval", hash: r.approval.txHash, url: r.approval.bscscan });
  if (r.swap?.txHash && r.swap.bscscan) txs.push({ label: r.kind === "funding" ? "funding swap" : "swap", hash: r.swap.txHash, url: r.swap.bscscan });
  return {
    id: r.id,
    createdAt: r.createdAt,
    what: r.kind === "funding" ? "BNB to USDT funding" : r.symbol,
    kind: r.kind,
    mode: r.mode,
    outcome: r.outcome,
    usd: r.usd,
    verdict: r.gate?.verdict ?? null,
    quotedPerShare: r.fill?.quotedFillPerShare ?? r.quote?.fillPerShare ?? null,
    filledPerShare: r.fill?.fillPerShare ?? null,
    realizedVsQuotedPct: r.fill?.realizedVsQuotedPct ?? null,
    realizedGapPct: r.fill?.realizedGapPct ?? null,
    tokensOut: r.fill?.tokensOut ?? null,
    refusal: r.refusal ? { code: r.refusal.code, message: r.refusal.message } : null,
    txs,
  };
}

export interface Ledger {
  /** Runs that put a transaction on chain (fills, and approvals that went through before a refusal). */
  onChain: LedgerRow[];
  /** Refusals, which stop before anything is signed. */
  refusals: LedgerRow[];
  dryRuns: number;
}

export function buildLedger(receipts: ExecReceipt[]): Ledger {
  const rows = receipts.map(toLedgerRow).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    onChain: rows.filter((r) => r.txs.length > 0),
    refusals: rows.filter((r) => r.outcome === "REFUSED" && r.txs.length === 0),
    dryRuns: rows.filter((r) => r.outcome === "SIMULATED").length,
  };
}
