import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TransactionReceipt } from "viem";
import {
  createBawRunner,
  executeContractCall,
  findTxSince,
  previewContractCall,
  type ContractCall,
  type ContractCallPreview,
  type ContractCallResult,
} from "./baw";
import {
  bscClient,
  bscTxUrl,
  createChainReader,
  decodeApprove,
  simulateWithOverrides,
  transferSum,
  type ChainReader,
  type OverrideSim,
} from "./chain";
import { USDT_BSC, type Platform } from "./config";
import { DEFAULT_POLICY, evaluateVenue, type GateReason, type Policy, type Verdict, type VenueVerdict } from "./gate";
import { buildMatrix, type MatrixRow } from "./matrix";
import { getQuote, getSellQuote, usdToBaseUnits, type ExecQuote, type QuoteOk } from "./quotes";
import { loadRegistry, resolve } from "./registry";
import type { ApproveTx, QuoteRoute, SimulateResult, SwapResponse } from "./schemas";
import type { SessionName } from "./session";
import {
  NATIVE_BNB,
  buildSwap,
  getApproveTx,
  quoteRoute,
  simulateTx,
  simulatedChange,
  txDetail,
  type EvmTx,
  type RouteParams,
  type SwapParams,
} from "./trade";

export type ExecMode = "dry-run" | "live";
export type Outcome = "FILLED" | "SIMULATED" | "REFUSED" | "FAILED" | "PENDING" | "PLACED" | "CANCELED";
export type ExecVia = "contract-call" | "market-order";

export type RefusalCode =
  | "EXEC_DISABLED"
  | "NO_WALLET"
  | "BAD_SIZE"
  | "SIZE_OVER_CAP"
  | "DAILY_CAP"
  | "NOT_A_VENUE"
  | "GATE_NOT_GO"
  | "QUOTE_STALE"
  | "MODE_RFQ_UNSUPPORTED"
  | "NO_APPROVE_TARGET"
  | "APPROVE_NOT_EXACT"
  | "APPROVE_SPENDER_MISMATCH"
  | "APPROVAL_NOT_EFFECTIVE"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_GAS"
  | "TX_FROM_MISMATCH"
  | "TX_TARGET_MISMATCH"
  | "TX_VALUE_MISMATCH"
  | "WORST_CASE_GAP"
  | "SIMULATION_FAILED"
  | "PREVIEW_REJECTED"
  | "USER_DECLINED"
  | "PENDING_TIMEOUT"
  | "TX_REVERTED"
  | "WALLET_QUOTE_MISMATCH"
  | "NO_POSITION"
  | "SELL_VIA_UNSUPPORTED"
  | "TRIGGER_AT_MARKET"
  | "ORDER_FAILED"
  | "ORDER_TIMEOUT"
  | "WALLET_REJECTED";

/** A rail stopped the run. Before anything is broadcast this is a REFUSED receipt; after, FAILED. */
export class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "Refusal";
  }
}

export interface GateResult {
  ticker: string;
  row: MatrixRow;
  session: SessionName | null;
  verdict: VenueVerdict;
  quote: ExecQuote | null;
}

export interface ExecDeps {
  gate(symbol: string, usd: number, wallet: string, policy: Policy): Promise<GateResult>;
  requote(prev: GateResult, usd: number, wallet: string, policy: Policy): Promise<GateResult>;
  api: {
    getApproveTx(token: string, amount: string): Promise<ApproveTx>;
    buildSwap(p: SwapParams): Promise<SwapResponse>;
    simulateTx(tx: EvmTx): Promise<SimulateResult>;
    quoteRoute(p: RouteParams): Promise<{ route: QuoteRoute; routeCount: number }>;
    txDetail(hash: string): Promise<unknown>;
  };
  chain: ChainReader;
  overrideSim(tx: EvmTx, o: { token: string; balance: bigint; spender: string; allowance: bigint }): Promise<OverrideSim>;
  baw: {
    preview(c: ContractCall): Promise<ContractCallPreview>;
    execute(requestId: string): Promise<ContractCallResult>;
    findTxSince(sinceMs: number, to: string): Promise<string | null>;
  };
  /** Final human check before a live broadcast; the CLI prompts unless `--yes`. */
  confirm(summary: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(step: string, detail?: string): void;
}

export interface TxRecord {
  to: string;
  value: string;
  preview?: { requestId: string; requireConfirmation: boolean; simulationOk: boolean; risks: unknown[] };
  broadcastStatus?: string;
  txHash?: string;
  bscscan?: string;
  blockNumber?: string;
  gasUsed?: string;
  gasCostBnb?: number;
}

export interface ExecReceipt {
  version: 1;
  id: string;
  kind: "trade" | "funding" | "limit";
  createdAt: string;
  mode: ExecMode;
  outcome: Outcome;
  refusal: { code: RefusalCode | "ERROR"; message: string } | null;
  symbol: string;
  venue: { ticker: string; platform: Platform; address: string } | null;
  /** Buy: USDT paid. Sell: USDT expected (then received). Limit: USDT committed. */
  usd: number;
  wallet: string;
  /** Absent on receipts written before sells existed: those are buys. */
  side?: "buy" | "sell";
  via?: ExecVia;
  /** Agentic Wallet market or limit order. */
  order?: { id: string; status: string; raw: unknown } | null;
  /** The wallet's own market-order quote, checked against the gated aggregator quote. */
  walletQuote?: { fromQty: string; toQty: string; fillPerShare: number; deviationPct: number; gapPct: number | null } | null;
  limit?: { triggerPriceUsd: number; discountPct: number; qty: string; walletPricePerToken: number | null } | null;
  gate: {
    verdict: Verdict;
    session: SessionName | null;
    reasons: GateReason[];
    reference: number | null;
    displayedGapPct: number | null;
    executableGapPct: number | null;
    fillPerShare: number | null;
    quoteAgeSec: number | null;
  } | null;
  quote: {
    tokensOut: number;
    fillPerShare: number;
    vendorName: string | null;
    executionMode: string | null;
    route: string[];
    vendorPriceImpact: number | null;
    networkFeeUsd: number | null;
    approveTarget: string | null;
  } | null;
  balances: { usdt: string; bnb: string; allowance: string; token?: string } | null;
  approval: ({ needed: boolean; amount: string; spender: string; allowanceBefore: string } & Omit<TxRecord, "to" | "value"> & Partial<Pick<TxRecord, "to" | "value">>) | null;
  swap: (TxRecord & { minReceiveAmount: string | null; slippagePct: number | null; gas: string | null; gasPrice: string | null; worstCaseGapPct: number | null }) | null;
  simulation: {
    source: "binance-transaction-api" | "eth_call-state-override";
    status: string;
    failReason: string | null;
    tokenDelta: string | null;
    apiStatus?: string;
    apiFailReason?: string | null;
    overrides?: OverrideSim["overrides"];
  } | null;
  fill: {
    /** Stock tokens received (buy) or sold (sell). */
    tokensOut: number;
    /** USDT paid; 0 on a sell. */
    usdSpent: number;
    /** Sell only: USDT received. */
    usdReceived?: number;
    source?: "transfer-logs" | "balance-change";
    fillPerShare: number | null;
    quotedFillPerShare: number | null;
    realizedVsQuotedPct: number | null;
    realizedGapPct: number | null;
  } | null;
  txDetail: unknown;
  steps: Array<{ at: string; step: string; detail?: string }>;
}

export interface ExecResult {
  receipt: ExecReceipt;
  path: string | null;
}

export const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();
export const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
export const units = (raw: bigint, decimals = 18) => Number(raw) / 10 ** decimals;
const PENDING_POLL_MS = 5_000;
const PENDING_TIMEOUT_MS = 5 * 60_000;
/** Reserve left in BNB after funding so later approve + swap gas is always covered. */
export const GAS_RESERVE_WEI = 1_000_000_000_000_000n;

// ---------- default wiring ----------

const venueOf = (r: MatrixRow) => ({ ticker: r.ticker, platform: r.platform, symbol: r.symbol, address: r.address, multiplier: r.multiplier ?? 1 });

export interface VenueContext {
  ticker: string;
  row: MatrixRow;
  session: SessionName | null;
}

export async function gateRow(row: MatrixRow, session: SessionName | null, usd: number, wallet: string, policy: Policy): Promise<GateResult> {
  const quote = await getQuote(venueOf(row), usd, { multiplier: row.multiplier, reference: row.reference, wallet });
  return { ticker: row.ticker, row, session, verdict: evaluateVenue({ row, quote }, { session, now: Date.now() }, policy), quote };
}

/** Quotes selling exactly `qty` base units of the venue token for USDT, then runs the sell-side gate. */
export async function gateSellRow(ctx: VenueContext, qty: bigint, decimals: number, wallet: string, policy: Policy): Promise<GateResult> {
  const { row, session } = ctx;
  const quote = await getSellQuote(venueOf(row), qty, decimals, { multiplier: row.multiplier, reference: row.reference, wallet });
  return { ticker: row.ticker, row, session, verdict: evaluateVenue({ row, quote }, { session, now: Date.now() }, policy), quote };
}

/** Resolves a venue symbol (or address) and rebuilds its matrix row from live data. */
export async function venueContext(symbol: string): Promise<VenueContext> {
  const res = resolve(await loadRegistry(), symbol);
  if (!res?.match) throw new Refusal("NOT_A_VENUE", `"${symbol}" is not a BSC tokenized stock symbol or address. Pass a venue such as NVDAB, not a ticker.`);
  const matrix = await buildMatrix({ scope: "all", tickers: [res.ticker] });
  const row = matrix.rows.find((r) => r.symbol === res.match!.symbol);
  if (!row) throw new Refusal("NOT_A_VENUE", `No live data for ${res.match.symbol}.`);
  return { ticker: res.ticker, row, session: matrix.session?.session ?? null };
}

/** Resolves a venue, rebuilds its matrix row from live data, then quotes and gates a buy. */
export async function gateVenue(symbol: string, usd: number, wallet: string, policy: Policy): Promise<GateResult> {
  const ctx = await venueContext(symbol);
  return gateRow(ctx.row, ctx.session, usd, wallet, policy);
}

export function defaultExecDeps(): ExecDeps {
  const client = bscClient();
  const run = createBawRunner();
  return {
    gate: gateVenue,
    requote: (prev, usd, wallet, policy) => gateRow(prev.row, prev.session, usd, wallet, policy),
    api: {
      getApproveTx: (t, a) => getApproveTx(t, a),
      buildSwap: (p) => buildSwap(p),
      simulateTx: (tx) => simulateTx(tx),
      quoteRoute: (p) => quoteRoute(p),
      txDetail: (h) => txDetail(h),
    },
    chain: createChainReader(client),
    overrideSim: (tx, o) => simulateWithOverrides(tx, o, client),
    baw: {
      preview: (c) => previewContractCall(c, run),
      execute: (id) => executeContractCall(id, run),
      findTxSince: (since, to) => findTxSince(since, to, run),
    },
    confirm: async () => false,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: () => {},
  };
}

// ---------- receipts ----------

export function receiptId(kind: ExecReceipt["kind"], symbol: string, now: number): string {
  const tag = kind === "funding" ? "fund" : kind === "limit" ? "limit" : "exec";
  return `${new Date(now).toISOString().replace(/[:.]/g, "-")}-${tag}-${symbol.replace(/[^A-Za-z0-9]/g, "")}`;
}

export function writeReceipt(dir: string, r: ExecReceipt): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${r.id}.json`);
  writeFileSync(path, `${JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  return path;
}

export function listReceipts(dir: string): ExecReceipt[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ExecReceipt);
}

/**
 * Live USDT committed to stock buys on the UTC day of `now`: buys that FILLED (or are PENDING with a
 * hash or order id), plus limit buys PLACED and not since cancelled. Sells spend nothing.
 */
export function spentTodayUsd(receipts: ExecReceipt[], now: number): number {
  const day = new Date(now).toISOString().slice(0, 10);
  const today = receipts.filter((r) => r.mode === "live" && r.createdAt.slice(0, 10) === day);
  const canceled = new Set(today.filter((r) => r.kind === "limit" && r.outcome === "CANCELED" && r.order?.id).map((r) => r.order!.id));
  const buys = today
    .filter((r) => r.kind === "trade" && r.side !== "sell")
    .filter((r) => r.outcome === "FILLED" || (r.outcome === "PENDING" && (r.swap?.txHash || r.order?.id)))
    .reduce((sum, r) => sum + (r.fill?.usdSpent ?? r.usd), 0);
  const limits = today
    .filter((r) => r.kind === "limit" && r.outcome === "PLACED" && !(r.order?.id && canceled.has(r.order.id)))
    .reduce((sum, r) => sum + r.usd, 0);
  return buys + limits;
}

// ---------- shared run machinery ----------

export interface Run<D extends Pick<ExecDeps, "now" | "log"> = ExecDeps> {
  r: ExecReceipt;
  d: D;
  step(step: string, detail?: string): void;
  broadcast: boolean;
}

export function newRun<D extends Pick<ExecDeps, "now" | "log">>(kind: ExecReceipt["kind"], symbol: string, usd: number, mode: ExecMode, wallet: string, d: D): Run<D> {
  const now = d.now();
  const r: ExecReceipt = {
    version: 1,
    id: receiptId(kind, symbol, now),
    kind,
    createdAt: new Date(now).toISOString(),
    mode,
    outcome: "REFUSED",
    refusal: null,
    symbol,
    venue: null,
    usd,
    wallet,
    gate: null,
    quote: null,
    balances: null,
    approval: null,
    swap: null,
    simulation: null,
    fill: null,
    txDetail: null,
    steps: [],
  };
  const run: Run<D> = {
    r,
    d,
    broadcast: false,
    step(step, detail) {
      r.steps.push({ at: new Date(d.now()).toISOString(), step, ...(detail ? { detail } : {}) });
      d.log(step, detail);
    },
  };
  return run;
}

export function commonRails(env: NodeJS.ProcessEnv, wallet: string | undefined): asserts wallet is string {
  const kill = env.GAP_EXEC_DISABLED?.trim();
  if (kill && kill !== "0" && kill.toLowerCase() !== "false") throw new Refusal("EXEC_DISABLED", "Execution is disabled by GAP_EXEC_DISABLED.");
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Refusal("NO_WALLET", "GAP_WALLET_ADDRESS is not set to a valid address.");
}

/** Wallet preview, rails on its result, the human confirmation, execute, then wait for a successful receipt. */
async function signAndWait(run: Run, call: ContractCall, rec: Omit<TxRecord, "to" | "value">, label: string, summary: string, exclude: string[] = []): Promise<TransactionReceipt> {
  const { d } = run;
  run.step(`${label}: wallet preview`);
  const p = await d.baw.preview(call);
  rec.preview = { requestId: p.requestId, requireConfirmation: p.requireConfirmation, simulationOk: p.simulationOk, risks: p.risks };
  if (!p.simulationOk) throw new Refusal("PREVIEW_REJECTED", `Agentic Wallet simulation failed for the ${label}: ${p.simulationError ?? "unknown error"}.`);
  if (p.risks.length) throw new Refusal("PREVIEW_REJECTED", `Agentic Wallet risk scan flagged the ${label}: ${JSON.stringify(p.risks).slice(0, 300)}.`);
  if (!(await d.confirm(`${summary}${p.requireConfirmation ? "\nThe wallet will also ask you to confirm in the Binance app." : ""}`))) {
    throw new Refusal("USER_DECLINED", `Declined at the confirmation prompt (${label}).`);
  }
  const since = d.now();
  run.step(`${label}: execute`);
  const res = await d.baw.execute(p.requestId);
  rec.broadcastStatus = res.status;
  let hash = res.txHash;
  if (!hash && res.status === "PENDING_CONFIRMATION") {
    run.step(`${label}: waiting for confirmation in the Binance app`);
    for (let waited = 0; !hash && waited < PENDING_TIMEOUT_MS; waited += PENDING_POLL_MS) {
      await d.sleep(PENDING_POLL_MS);
      const found = await d.baw.findTxSince(since - 60_000, call.to).catch(() => null);
      if (found && !exclude.includes(found)) hash = found;
    }
  }
  if (!hash) {
    if (label !== "approval") run.broadcast = true;
    throw new Refusal("PENDING_TIMEOUT", `No transaction hash for the ${label} (status ${res.status}); check the Binance app.`);
  }
  if (label !== "approval") run.broadcast = true;
  rec.txHash = hash;
  rec.bscscan = bscTxUrl(hash);
  run.step(`${label}: broadcast`, hash);
  const receipt = await d.chain.waitForReceipt(hash);
  rec.blockNumber = receipt.blockNumber.toString();
  rec.gasUsed = receipt.gasUsed.toString();
  rec.gasCostBnb = units(receipt.gasUsed * receipt.effectiveGasPrice);
  if (receipt.status !== "success") throw new Refusal("TX_REVERTED", `The ${label} transaction reverted on-chain (${hash}).`);
  run.step(`${label}: confirmed`, `block ${receipt.blockNumber}`);
  return receipt;
}

function checkSwapTx(s: SwapResponse, wallet: string, router: string, value: string): NonNullable<SwapResponse["tx"]> {
  if (lower(s.executionMode) !== "swap" || !s.tx) {
    throw new Refusal("MODE_RFQ_UNSUPPORTED", `The route is ${s.executionMode ?? "unknown"}; only SWAP routes are executed (no RFQ route has been seen live).`);
  }
  const tx = s.tx;
  if (lower(tx.from) !== lower(wallet)) throw new Refusal("TX_FROM_MISMATCH", `Swap tx is from ${tx.from}, not the wallet ${wallet}.`);
  if (lower(tx.to) !== lower(router)) throw new Refusal("TX_TARGET_MISMATCH", `Swap tx targets ${tx.to}, not the quoted router ${router}.`);
  if (tx.value !== value) throw new Refusal("TX_VALUE_MISMATCH", `Swap tx sends ${tx.value} wei of BNB; expected ${value}.`);
  return tx;
}

export async function finishRun(run: Run<Pick<ExecDeps, "now" | "log">>, dir: string | null, err?: unknown): Promise<ExecResult> {
  const { r } = run;
  if (err !== undefined) {
    const code = err instanceof Refusal ? err.code : "ERROR";
    const message = err instanceof Error ? err.message : String(err);
    r.refusal = { code, message };
    // Only the swap broadcast matters: an approval alone buys nothing, so a later stop is still a refusal.
    if (!run.broadcast) r.outcome = err instanceof Refusal ? "REFUSED" : "FAILED";
    else r.outcome = code === "TX_REVERTED" || code === "ORDER_FAILED" ? "FAILED" : "PENDING";
    run.step(r.outcome === "REFUSED" ? "refused" : "stopped", `${code}: ${message}`);
  }
  return { receipt: r, path: dir ? writeReceipt(dir, r) : null };
}

// ---------- gated stock buy ----------

export interface ExecOptions {
  usd: number;
  /** The contract-call path only buys; a sell is refused with SELL_VIA_UNSUPPORTED. */
  side?: "buy" | "sell";
  live?: boolean;
  wallet?: string;
  policy?: Policy;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<ExecDeps>;
  /** Where receipts are written and today's spend is read from; null skips writing (tests). */
  receiptsDir?: string | null;
}

export function requireGo(g: GateResult, policy: Policy, now: number): QuoteOk {
  const q = g.quote;
  if (q?.ok && q.executionMode && lower(q.executionMode) !== "swap") {
    throw new Refusal("MODE_RFQ_UNSUPPORTED", `The best route is ${q.executionMode}; only SWAP routes are executed (no RFQ route has been seen live).`);
  }
  if (g.verdict.verdict !== "GO") {
    const why = g.verdict.reasons.filter((x) => x.severity !== "info").map((x) => x.message).join(" ");
    throw new Refusal("GATE_NOT_GO", `Gate verdict is ${g.verdict.verdict}, and only GO executes. ${why}`.trim());
  }
  if (!q?.ok || !q.quoteId) throw new Refusal("GATE_NOT_GO", "No executable quote.");
  const ageSec = (now - q.ts) / 1000;
  if (ageSec > policy.quoteMaxAgeSec) throw new Refusal("QUOTE_STALE", `Quote is ${Math.round(ageSec)}s old; the limit is ${policy.quoteMaxAgeSec}s.`);
  return q;
}

export function recordGate(r: ExecReceipt, g: GateResult, now: number) {
  const v = g.verdict;
  const q = g.quote;
  r.venue = { ticker: g.ticker, platform: g.row.platform, address: g.row.address };
  r.gate = {
    verdict: v.verdict,
    session: g.session,
    reasons: v.reasons,
    reference: g.row.reference,
    displayedGapPct: v.displayedGapPct,
    executableGapPct: v.executableGapPct,
    fillPerShare: v.fillPerShare,
    quoteAgeSec: q ? Math.round((now - q.ts) / 100) / 10 : null,
  };
  r.quote = q?.ok
    ? {
        tokensOut: q.tokensOut,
        fillPerShare: q.fillPerShare,
        vendorName: q.vendorName,
        executionMode: q.executionMode,
        route: q.route,
        vendorPriceImpact: q.vendorPriceImpact,
        networkFeeUsd: q.networkFeeUsd,
        approveTarget: q.approveTarget,
      }
    : null;
}

/**
 * Buys `usd` of USDT worth of a venue token, only on a fresh GO verdict. Dry run (the default)
 * does everything except signing. Every path, including refusals, writes a receipt.
 */
export async function executeTrade(symbol: string, opts: ExecOptions): Promise<ExecResult> {
  const env = opts.env ?? process.env;
  const policy = opts.policy ?? DEFAULT_POLICY;
  const d: ExecDeps = { ...defaultExecDepsLazy(opts.deps), ...opts.deps } as ExecDeps;
  const wallet = opts.wallet ?? env.GAP_WALLET_ADDRESS ?? "";
  const mode: ExecMode = opts.live ? "live" : "dry-run";
  const dir = opts.receiptsDir === undefined ? null : opts.receiptsDir;
  const run = newRun("trade", symbol, opts.usd, mode, wallet, d);
  const { r } = run;
  r.side = opts.side ?? "buy";
  r.via = "contract-call";
  try {
    commonRails(env, wallet);
    if (r.side === "sell") throw new Refusal("SELL_VIA_UNSUPPORTED", "Sells go through the Agentic Wallet market order (via market-order); the contract-call path only buys.");
    if (!(opts.usd > 0) || !Number.isFinite(opts.usd)) throw new Refusal("BAD_SIZE", `Size must be a positive USD amount, got ${opts.usd}.`);
    if (opts.usd > policy.maxTradeUsd) throw new Refusal("SIZE_OVER_CAP", `$${opts.usd} is over the $${policy.maxTradeUsd} per-trade cap.`);
    if (mode === "live") {
      const spent = spentTodayUsd(dir ? listReceipts(dir) : [], d.now());
      if (spent + opts.usd > policy.maxDailySpendUsd) {
        throw new Refusal("DAILY_CAP", `$${spent.toFixed(2)} already spent today; $${opts.usd} more would pass the $${policy.maxDailySpendUsd} daily cap.`);
      }
    }

    run.step("gate", `${symbol} at $${opts.usd}`);
    let g = await d.gate(symbol, opts.usd, wallet, policy);
    recordGate(r, g, d.now());
    let q = requireGo(g, policy, d.now());
    run.step("gate passed", `GO, fill ${pct(g.verdict.executableGapPct ?? 0)} vs the stock`);
    const router = q.approveTarget;
    if (!router) throw new Refusal("NO_APPROVE_TARGET", "The quote names no approve target, so the spender cannot be verified.");

    const amount = usdToBaseUnits(opts.usd);
    const need = BigInt(amount);
    const [usdt, bnb, allowance] = await Promise.all([
      d.chain.balance(USDT_BSC, wallet),
      d.chain.balance(NATIVE_BNB, wallet),
      d.chain.allowance(USDT_BSC, wallet, router),
    ]);
    r.balances = { usdt: usdt.toString(), bnb: bnb.toString(), allowance: allowance.toString() };
    const funded = usdt >= need;
    if (mode === "live" && !funded) throw new Refusal("INSUFFICIENT_BALANCE", `Wallet holds ${units(usdt).toFixed(4)} USDT; the trade needs ${opts.usd}.`);

    if (allowance < need) {
      const a = await d.api.getApproveTx(USDT_BSC, amount);
      const dec = decodeApprove(a.data);
      if (!dec || dec.amount !== need) {
        throw new Refusal("APPROVE_NOT_EXACT", `Approval calldata ${dec ? `approves ${dec.amount}` : "is not approve()"}; only the exact amount ${amount} is allowed.`);
      }
      if (lower(dec.spender) !== lower(router) || lower(a.dexContractAddress) !== lower(router)) {
        throw new Refusal("APPROVE_SPENDER_MISMATCH", `Approval spender ${dec.spender} does not match the quoted router ${router}.`);
      }
      r.approval = { needed: true, amount, spender: router, allowanceBefore: allowance.toString(), to: USDT_BSC, value: "0" };
      run.step("approval checked", `exact ${opts.usd} USDT to ${router}`);
      if (mode === "live") {
        const gasNeed = (BigInt(a.gasLimit ?? "70000") + BigInt(q.gasLimit ?? 450_000)) * BigInt(a.gasPrice ?? "0");
        if (bnb < gasNeed) throw new Refusal("INSUFFICIENT_GAS", `Wallet holds ${units(bnb)} BNB; approve + swap gas needs about ${units(gasNeed)}.`);
        await signAndWait(run, { from: wallet, to: USDT_BSC, value: "0", data: a.data }, r.approval, "approval", `Approve exactly ${opts.usd} USDT to the router ${router}?`);
        const after = await d.chain.allowance(USDT_BSC, wallet, router);
        if (after < need) throw new Refusal("APPROVAL_NOT_EFFECTIVE", `Allowance is ${after} after the approval; expected at least ${amount}.`);
      }
    } else {
      r.approval = { needed: false, amount, spender: router, allowanceBefore: allowance.toString() };
    }

    run.step("re-quote");
    g = await d.requote(g, opts.usd, wallet, policy);
    recordGate(r, g, d.now());
    q = requireGo(g, policy, d.now());
    if (lower(q.approveTarget) !== lower(router)) throw new Refusal("TX_TARGET_MISMATCH", `Router changed between quotes (${router} to ${q.approveTarget}).`);

    const s = await d.api.buildSwap({ fromToken: USDT_BSC, toToken: g.row.address, amount, wallet, quoteId: q.quoteId!, slippagePct: policy.slippagePct });
    const tx = checkSwapTx(s, wallet, router, "0");
    const minOut = tx.minReceiveAmount ? BigInt(tx.minReceiveAmount) : null;
    const ref = g.row.reference;
    const worst = minOut && minOut > 0n && ref ? opts.usd / (units(minOut, q.tokenDecimals) * q.multiplier) / ref - 1 : null;
    r.swap = {
      to: tx.to,
      value: tx.value,
      minReceiveAmount: tx.minReceiveAmount,
      slippagePct: tx.slippagePercent,
      gas: tx.gas,
      gasPrice: tx.gasPrice,
      worstCaseGapPct: worst,
    };
    if (worst !== null && Math.abs(worst) > policy.cautionMaxGapPct) {
      throw new Refusal("WORST_CASE_GAP", `At the slippage floor the fill would be ${pct(worst)} vs the stock; the limit is ${(policy.cautionMaxGapPct * 100).toFixed(2)}%.`);
    }
    run.step("swap built", `min receive ${minOut ? units(minOut, q.tokenDecimals).toPrecision(6) : "n/a"} ${symbol}`);

    const evm: EvmTx = { from: wallet, to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gas, gasPrice: tx.gasPrice };
    const sim = await d.api.simulateTx(evm);
    const delta = simulatedChange(sim, wallet, g.row.address);
    if (sim.status === "SUCCESS") {
      r.simulation = { source: "binance-transaction-api", status: sim.status, failReason: sim.failReason, tokenDelta: delta.toString() };
      if (minOut && delta < minOut) throw new Refusal("SIMULATION_FAILED", `Simulation receives ${delta}, below the minimum ${minOut}.`);
    } else if (mode === "dry-run" && (!funded || allowance < need)) {
      const o = await d.overrideSim(evm, { token: USDT_BSC, balance: need, spender: router, allowance: need });
      r.simulation = {
        source: "eth_call-state-override",
        status: o.ok ? "SUCCESS" : "FAILED",
        failReason: o.error,
        tokenDelta: null,
        apiStatus: sim.status,
        apiFailReason: sim.failReason,
        overrides: o.overrides,
      };
      if (!o.ok) throw new Refusal("SIMULATION_FAILED", `Mainnet eth_call with a funded, approved wallet reverts: ${o.error}.`);
    } else {
      r.simulation = { source: "binance-transaction-api", status: sim.status, failReason: sim.failReason, tokenDelta: delta.toString() };
      throw new Refusal("SIMULATION_FAILED", `Simulation ${sim.status}: ${sim.failReason ?? "no reason given"}.`);
    }
    run.step("simulated", r.simulation.source);

    if (mode === "dry-run") {
      r.outcome = "SIMULATED";
      run.step("dry run: not broadcast", "pass --live to sign with the Agentic Wallet");
      return finishRun(run, dir);
    }

    const swapGas = BigInt(tx.gas ?? "450000") * BigInt(tx.gasPrice ?? "0");
    const bnbNow = await d.chain.balance(NATIVE_BNB, wallet);
    if (bnbNow < swapGas) throw new Refusal("INSUFFICIENT_GAS", `Wallet holds ${units(bnbNow)} BNB; the swap needs up to ${units(swapGas)}.`);
    const summary = `Buy ${symbol} with ${opts.usd} USDT: about ${q.tokensOut.toPrecision(6)} tokens at $${q.fillPerShare.toFixed(2)}/share (${pct(q.executableGapPct ?? 0)} vs the stock), at least ${minOut ? units(minOut, q.tokenDecimals).toPrecision(6) : "?"}.`;
    const receipt = await signAndWait(run, { from: wallet, to: tx.to, value: tx.value, data: tx.data }, r.swap, "swap", summary, r.approval?.txHash ? [r.approval.txHash] : []);

    const got = transferSum(receipt.logs, g.row.address, wallet, "to");
    const paid = transferSum(receipt.logs, USDT_BSC, wallet, "from");
    const tokensOut = units(got, q.tokenDecimals);
    const usdSpent = units(paid);
    const fill = tokensOut > 0 ? usdSpent / (tokensOut * q.multiplier) : null;
    r.fill = {
      tokensOut,
      usdSpent,
      fillPerShare: fill,
      quotedFillPerShare: q.fillPerShare,
      realizedVsQuotedPct: fill ? fill / q.fillPerShare - 1 : null,
      realizedGapPct: fill && ref ? (fill - ref) / ref : null,
    };
    r.outcome = "FILLED";
    run.step("filled", `${tokensOut.toPrecision(6)} ${symbol} for ${usdSpent.toFixed(4)} USDT`);
    r.txDetail = await d.api.txDetail(r.swap.txHash!).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    return finishRun(run, dir);
  } catch (err) {
    return finishRun(run, dir, err);
  }
}

// ---------- one-off funding: BNB to USDT ----------

export interface FundOptions {
  bnb: number;
  live?: boolean;
  wallet?: string;
  policy?: Policy;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<ExecDeps>;
  receiptsDir?: string | null;
}

export const bnbToWei = (bnb: number): string => (BigInt(Math.round(bnb * 1e9)) * 1_000_000_000n).toString();

/** Converts native BNB to USDT through the same swap, simulate and sign path; not gated (it buys no stock). */
export async function fundUsdt(opts: FundOptions): Promise<ExecResult> {
  const env = opts.env ?? process.env;
  const policy = opts.policy ?? DEFAULT_POLICY;
  const d: ExecDeps = { ...defaultExecDepsLazy(opts.deps), ...opts.deps } as ExecDeps;
  const wallet = opts.wallet ?? env.GAP_WALLET_ADDRESS ?? "";
  const mode: ExecMode = opts.live ? "live" : "dry-run";
  const dir = opts.receiptsDir === undefined ? null : opts.receiptsDir;
  const run = newRun("funding", "BNB-USDT", 0, mode, wallet, d);
  const { r } = run;
  try {
    commonRails(env, wallet);
    if (!(opts.bnb > 0) || !Number.isFinite(opts.bnb)) throw new Refusal("BAD_SIZE", `BNB amount must be positive, got ${opts.bnb}.`);
    const amount = bnbToWei(opts.bnb);
    const bnb = await d.chain.balance(NATIVE_BNB, wallet);
    const usdt = await d.chain.balance(USDT_BSC, wallet);
    r.balances = { usdt: usdt.toString(), bnb: bnb.toString(), allowance: "0" };
    if (bnb < BigInt(amount) + GAS_RESERVE_WEI) {
      throw new Refusal("INSUFFICIENT_GAS", `Wallet holds ${units(bnb)} BNB; converting ${opts.bnb} must leave ${units(GAS_RESERVE_WEI)} BNB for gas.`);
    }

    run.step("quote", `${opts.bnb} BNB to USDT`);
    const params: RouteParams = { fromToken: NATIVE_BNB, toToken: USDT_BSC, amount, wallet };
    const { route } = await d.api.quoteRoute(params);
    if (lower(route.executionMode) !== "swap") throw new Refusal("MODE_RFQ_UNSUPPORTED", `Funding route is ${route.executionMode}; only SWAP is executed.`);
    const router = route.approveTarget;
    if (!router) throw new Refusal("NO_APPROVE_TARGET", "The quote names no router to verify the swap target against.");
    const bnbUsd = route.fromToken?.tokenUnitPrice ?? null;
    r.usd = bnbUsd ? Math.round(opts.bnb * bnbUsd * 100) / 100 : 0;
    r.quote = {
      tokensOut: units(BigInt(route.toTokenAmount ?? "0")),
      fillPerShare: 0,
      vendorName: route.vendorName,
      executionMode: route.executionMode,
      route: ["BNB", "USDT"],
      vendorPriceImpact: route.priceImpactPercent,
      networkFeeUsd: route.tradeFee,
      approveTarget: router,
    };

    const s = await d.api.buildSwap({ ...params, quoteId: route.quoteId!, slippagePct: policy.slippagePct });
    const tx = checkSwapTx(s, wallet, router, amount);
    r.swap = { to: tx.to, value: tx.value, minReceiveAmount: tx.minReceiveAmount, slippagePct: tx.slippagePercent, gas: tx.gas, gasPrice: tx.gasPrice, worstCaseGapPct: null };
    const minOut = tx.minReceiveAmount ? BigInt(tx.minReceiveAmount) : null;

    const sim = await d.api.simulateTx({ from: wallet, to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gas, gasPrice: tx.gasPrice });
    const delta = simulatedChange(sim, wallet, USDT_BSC);
    r.simulation = { source: "binance-transaction-api", status: sim.status, failReason: sim.failReason, tokenDelta: delta.toString() };
    if (sim.status !== "SUCCESS") throw new Refusal("SIMULATION_FAILED", `Simulation ${sim.status}: ${sim.failReason ?? "no reason given"}.`);
    if (minOut && delta < minOut) throw new Refusal("SIMULATION_FAILED", `Simulation receives ${delta} USDT base units, below the minimum ${minOut}.`);
    run.step("simulated", `${units(delta).toFixed(4)} USDT`);

    if (mode === "dry-run") {
      r.outcome = "SIMULATED";
      run.step("dry run: not broadcast", "pass --live to sign with the Agentic Wallet");
      return finishRun(run, dir);
    }

    const receipt = await signAndWait(
      run,
      { from: wallet, to: tx.to, value: tx.value, data: tx.data },
      r.swap,
      "funding swap",
      `Convert ${opts.bnb} BNB (about $${r.usd}) to about ${units(delta).toFixed(4)} USDT (at least ${minOut ? units(minOut).toFixed(4) : "?"})?`,
    );
    const got = units(transferSum(receipt.logs, USDT_BSC, wallet, "to"));
    r.fill = { tokensOut: got, usdSpent: r.usd, fillPerShare: null, quotedFillPerShare: null, realizedVsQuotedPct: null, realizedGapPct: null };
    r.outcome = "FILLED";
    run.step("filled", `${got.toFixed(4)} USDT received`);
    r.txDetail = await d.api.txDetail(r.swap.txHash!).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    return finishRun(run, dir);
  } catch (err) {
    return finishRun(run, dir, err);
  }
}

/** Only build real clients (RPC, baw) for the deps a caller did not inject. */
function defaultExecDepsLazy(injected?: Partial<ExecDeps>): Partial<ExecDeps> {
  const needed: Array<keyof ExecDeps> = ["gate", "requote", "api", "chain", "overrideSim", "baw", "confirm", "now", "sleep", "log"];
  if (injected && needed.every((k) => k in injected)) return {};
  return defaultExecDeps();
}
