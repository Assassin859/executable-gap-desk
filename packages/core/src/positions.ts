import { formatUnits, parseUnits } from "viem";
import { createBawWallet, type Quota, type WalletToken } from "./bawWallet";
import { createChainReader, type ChainReader } from "./chain";
import { gateSellRow, type GateResult, type VenueContext } from "./execute";
import { DEFAULT_POLICY, type Policy, type Verdict } from "./gate";
import { buildMatrix, type MatrixResult } from "./matrix";
import { loadRegistry, resolve, type Venue } from "./registry";
import { getMarketSession, type MarketSession } from "./session";

export interface PositionsDeps {
  balance(): Promise<WalletToken[]>;
  quota(): Promise<Quota | null>;
  registry(): Promise<Venue[]>;
  matrix(tickers: string[]): Promise<Pick<MatrixResult, "rows" | "session">>;
  gateSell(ctx: VenueContext, qty: bigint, decimals: number, wallet: string, policy: Policy): Promise<GateResult>;
  decimals(token: string): Promise<number>;
  /** On-chain `balanceOf`; bStocks report a slightly higher balance in `baw wallet balance`, so sells size from this. */
  tokenBalance?(token: string, owner: string): Promise<bigint>;
  /** Used when no stock is held, since the matrix (which carries the session) is then skipped. */
  session?(): Promise<MarketSession | null>;
  now(): number;
}

export function defaultPositionsDeps(chain: ChainReader = createChainReader()): PositionsDeps {
  const w = createBawWallet();
  return {
    balance: () => w.balance(),
    quota: () => w.quota().catch(() => null),
    registry: loadRegistry,
    matrix: (tickers) => buildMatrix({ scope: "all", tickers }),
    gateSell: gateSellRow,
    decimals: async (t) => (await chain.decimals?.(t)) ?? 18,
    tokenBalance: (t, o) => chain.balance(t, o),
    session: () => getMarketSession().catch(() => null),
    now: Date.now,
  };
}

export interface StockPosition {
  symbol: string;
  ticker: string;
  platform: Venue["platform"];
  address: string;
  qty: string;
  multiplier: number;
  /** Venue's displayed token price times quantity. */
  displayedValue: number | null;
  /** Shares held (qty x multiplier) at the independent stock price. */
  stockValue: number | null;
  exit: {
    verdict: Verdict;
    usd: number | null;
    fillPerShare: number | null;
    gapPct: number | null;
    reasons: string[];
    codes: string[];
  };
}

export interface OtherBalance {
  symbol: string;
  address: string;
  qty: string;
  valueUsd: number | null;
}

export interface Positions {
  builtAt: string;
  wallet: string;
  session: { name: string; open: boolean; nextOpen: string | null; nextClose: string | null } | null;
  stocks: StockPosition[];
  other: OtherBalance[];
  totals: { displayed: number; stock: number; exitNow: number; other: number };
  quota: Quota | null;
  warnings: string[];
}

export const OPEN_WARNING_MIN = 60;

/** Warnings for `gap positions --warn-open`: the open is near and not in the regular session, or an exit is BLOCK. */
export function openWarnings(session: MarketSession | Positions["session"] | null, stocks: StockPosition[], now: number): string[] {
  const out: string[] = [];
  const name = session ? ("name" in session ? session.name : session.session) : null;
  const nextOpenRaw = session?.nextOpen ?? null;
  const nextOpen = nextOpenRaw ? new Date(nextOpenRaw).getTime() : null;
  if (stocks.length && name !== "regular" && nextOpen !== null) {
    const mins = (nextOpen - now) / 60_000;
    if (mins >= 0 && mins <= OPEN_WARNING_MIN) {
      const worst = stocks.some((s) => s.exit.verdict === "BLOCK") ? "BLOCK" : stocks.some((s) => s.exit.verdict === "CAUTION") ? "CAUTION" : "GO";
      out.push(`The US open is in ${Math.round(mins)} min: tokens can gap at the open; exit is currently ${worst}.`);
    }
  }
  for (const s of stocks) {
    if (s.exit.verdict === "BLOCK") out.push(`${s.symbol}: exit is BLOCK now (${s.exit.reasons[0] ?? "no executable quote"}).`);
  }
  return out;
}

const STABLES = new Set(["USDT", "USDC", "USD1", "U", "FDUSD"]);

/** Wallet holdings matched to tokenized-stock venues, each with a sell quote for the full quantity run through the sell gate. */
export async function buildPositions(wallet: string, deps: PositionsDeps = defaultPositionsDeps(), policy: Policy = DEFAULT_POLICY): Promise<Positions> {
  const [tokens, quota, venues] = await Promise.all([deps.balance(), deps.quota(), deps.registry()]);
  const held = tokens.filter((t) => Number(t.balance) > 0);
  const matched = held.map((t) => ({ t, res: /^0x[0-9a-fA-F]{40}$/.test(t.address) ? resolve(venues, t.address) : null }));
  const stockTokens = matched.filter((m) => m.res?.match);
  const tickers = [...new Set(stockTokens.map((m) => m.res!.ticker))];
  const matrix = tickers.length ? await deps.matrix(tickers) : { rows: [], session: (await deps.session?.()) ?? null };
  const sessionName = matrix.session?.session ?? null;

  const stocks: StockPosition[] = [];
  for (const { t, res } of stockTokens) {
    const v = res!.match!;
    const row = matrix.rows.find((r) => r.symbol === v.symbol);
    const decimals = await deps.decimals(v.address);
    const onchain = deps.tokenBalance ? await deps.tokenBalance(v.address, wallet).catch(() => null) : null;
    const qtyStr = onchain !== null ? formatUnits(onchain, decimals) : t.balance;
    const qty = Number(qtyStr);
    const multiplier = row?.multiplier ?? v.multiplier;
    const base: Omit<StockPosition, "exit"> = {
      symbol: v.symbol,
      ticker: v.ticker,
      platform: v.platform,
      address: v.address,
      qty: qtyStr,
      multiplier,
      displayedValue: row?.tokenPrice ? row.tokenPrice * qty : (t.value ?? null),
      stockValue: row?.reference ? row.reference * qty * multiplier : null,
    };
    if (!(qty > 0)) continue;
    if (!row) {
      stocks.push({ ...base, exit: { verdict: "BLOCK", usd: null, fillPerShare: null, gapPct: null, reasons: ["No live venue data."], codes: ["NO_QUOTE"] } });
      continue;
    }
    const g = await deps.gateSell({ ticker: v.ticker, row, session: sessionName }, parseUnits(qtyStr, decimals), decimals, wallet, policy);
    const q = g.quote?.ok ? g.quote : null;
    stocks.push({
      ...base,
      exit: {
        verdict: g.verdict.verdict,
        usd: q?.usd ?? null,
        fillPerShare: q?.fillPerShare ?? null,
        gapPct: g.verdict.executableGapPct,
        reasons: g.verdict.reasons.filter((r) => r.severity !== "info").map((r) => r.message),
        codes: g.verdict.reasons.map((r) => r.code),
      },
    });
  }

  const stockAddrs = new Set(stockTokens.map((m) => m.t.address.toLowerCase()));
  const other: OtherBalance[] = held
    .filter((t) => !stockAddrs.has(t.address.toLowerCase()))
    .map((t) => ({ symbol: t.symbol, address: t.address, qty: t.balance, valueUsd: t.value ?? (STABLES.has(t.symbol) ? Number(t.balance) : null) }));

  const sum = (xs: Array<number | null>) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  const s = matrix.session;
  const session = s
    ? { name: s.session, open: s.open, nextOpen: s.nextOpen?.toISOString() ?? null, nextClose: s.nextClose?.toISOString() ?? null }
    : null;
  return {
    builtAt: new Date(deps.now()).toISOString(),
    wallet,
    session,
    stocks,
    other,
    totals: {
      displayed: sum(stocks.map((x) => x.displayedValue)),
      stock: sum(stocks.map((x) => x.stockValue)),
      exitNow: sum(stocks.map((x) => x.exit.usd)),
      other: sum(other.map((x) => x.valueUsd)),
    },
    quota,
    warnings: openWarnings(session, stocks, deps.now()),
  };
}
