import type { ExecReceipt, Outcome, Verdict, X402Outcome, X402Receipt } from "@gapdesk/core";

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

const bscscanTx = (hash: string): string => `https://bscscan.com/tx/${hash}`;

/** `receipts/x402-sales/*.json`: a paid sale of our own endpoint, checked on-chain. */
export interface SaleRecord {
  at: string;
  seller: { endpoint: string; route: string; priceU: string; payTo: string };
  buyer: { address: string; via: string; independent: boolean; note?: string };
  http: { status: number };
  settlement: { transaction: string; onchain: { block: string; time: string; from: string; gasUsed: string; effectiveGasPriceGwei: string } };
  buyerReceipt?: string;
}

/** `receipts/identity.json`. */
export interface IdentityRecord {
  createdAt: string;
  outcome: string;
  agentId: string;
  registry: string;
  agentRegistry: string;
  agentURI: string;
  wallet: string;
  tx: { txHash: string; blockNumber: string; gasUsed: string; gasCostBnb: number };
}

/** `receipts/b402/*.json` from `gap b402 selftest`. */
export interface B402SelftestRecord {
  createdAt: string;
  mode: string;
  outcome: string;
  wallet: string;
  payTo: string;
  resource: string;
  option: { token: string; amount: string } | null;
  verify: { isValid: boolean; invalidReason: string | null; payer: string | null } | null;
}

/** `receipts/x402-onchain.json`: settlements found on-chain for sellers whose PAYMENT-RESPONSE had no tx. */
export type OnchainAnnotations = Record<string, { tx: string; foundBy: string }>;

export interface PurchaseRow {
  id: string;
  createdAt: string;
  seller: string;
  label: string;
  amount: string | null;
  token: string | null;
  outcome: X402Outcome;
  httpStatus: number | null;
  error: string | null;
  tx: LedgerTx | null;
  txFoundOnchain: boolean;
}

export interface SaleRow {
  at: string;
  endpoint: string;
  priceU: string;
  buyer: string;
  payTo: string;
  independent: boolean;
  note: string | null;
  httpStatus: number;
  tx: LedgerTx;
  block: string;
  settledAt: string;
  submittedBy: string;
  gasUsed: string;
  gasPriceGwei: string;
}

export interface X402Ledger {
  purchases: PurchaseRow[];
  sales: SaleRow[];
  dryRuns: number;
}

const amountLabel = (a: string): string => a.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function toPurchaseRow(r: X402Receipt, onchain: OnchainAnnotations): PurchaseRow {
  const settled = r.settlement?.transaction ?? null;
  const found = settled ? null : (onchain[r.id]?.tx ?? null);
  const hash = settled ?? found;
  return {
    id: r.id,
    createdAt: r.createdAt,
    seller: hostOf(r.url),
    label: r.label,
    amount: r.option ? amountLabel(r.option.amount) : null,
    token: r.option?.token ?? null,
    outcome: r.outcome,
    httpStatus: r.httpStatus,
    error: r.settlement?.errorReason ?? r.refusal?.message ?? null,
    tx: hash ? { label: "settlement", hash, url: bscscanTx(hash) } : null,
    txFoundOnchain: Boolean(found),
  };
}

function toSaleRow(s: SaleRecord): SaleRow {
  const hash = s.settlement.transaction;
  return {
    at: s.at,
    endpoint: s.seller.endpoint,
    priceU: s.seller.priceU,
    buyer: s.buyer.address,
    payTo: s.seller.payTo,
    independent: s.buyer.independent,
    note: s.buyer.note ?? null,
    httpStatus: s.http.status,
    tx: { label: "B402 settlement", hash, url: bscscanTx(hash) },
    block: s.settlement.onchain.block,
    settledAt: s.settlement.onchain.time,
    submittedBy: s.settlement.onchain.from,
    gasUsed: s.settlement.onchain.gasUsed,
    gasPriceGwei: s.settlement.onchain.effectiveGasPriceGwei,
  };
}

/**
 * Live x402 purchases from other sellers, and our own sales. A purchase of one of our own sold
 * endpoints is the buyer side of a sale, so it is listed once, as the sale.
 */
export function buildX402Ledger(receipts: X402Receipt[], sales: SaleRecord[], onchain: OnchainAnnotations = {}): X402Ledger {
  const soldHosts = new Set(sales.map((s) => hostOf(s.seller.endpoint)));
  const live = receipts.filter((r) => r.mode === "live");
  return {
    purchases: live
      .filter((r) => !soldHosts.has(hostOf(r.url)))
      .map((r) => toPurchaseRow(r, onchain))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    sales: sales.map(toSaleRow).sort((a, b) => a.at.localeCompare(b.at)),
    dryRuns: receipts.filter((r) => r.mode !== "live").length,
  };
}

export interface IdentityRow {
  agentId: string;
  registeredAt: string;
  registry: string;
  agentRegistry: string;
  agentURI: string;
  owner: string;
  tx: LedgerTx;
  block: string;
  gasUsed: string;
  gasCostBnb: number;
}

export function identityRow(r: IdentityRecord | null): IdentityRow | null {
  if (!r || r.outcome !== "REGISTERED") return null;
  return {
    agentId: r.agentId,
    registeredAt: r.createdAt,
    registry: r.registry,
    agentRegistry: r.agentRegistry,
    agentURI: r.agentURI,
    owner: r.wallet,
    tx: { label: "register(agentURI)", hash: r.tx.txHash, url: bscscanTx(r.tx.txHash) },
    block: r.tx.blockNumber,
    gasUsed: r.tx.gasUsed,
    gasCostBnb: r.tx.gasCostBnb,
  };
}

export interface SelftestRow {
  at: string;
  resource: string;
  amount: string | null;
  token: string | null;
  isValid: boolean;
  invalidReason: string | null;
  payer: string | null;
  payTo: string;
}

export function selftestRow(r: B402SelftestRecord | null): SelftestRow | null {
  if (!r || r.mode !== "live" || !r.verify) return null;
  return {
    at: r.createdAt,
    resource: r.resource,
    amount: r.option ? amountLabel(r.option.amount) : null,
    token: r.option?.token ?? null,
    isValid: r.verify.isValid,
    invalidReason: r.verify.invalidReason,
    payer: r.verify.payer,
    payTo: r.payTo,
  };
}
