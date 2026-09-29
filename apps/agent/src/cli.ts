#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import Table from "cli-table3";
import pc from "picocolors";
import {
  ApiError,
  CHAIN_ID,
  DEFAULT_LADDER,
  DEFAULT_POLICY,
  buildSnapshot,
  checkTicker,
  MissingCredentialsError,
  QUOTE_REASON_TEXT,
  buildMatrix,
  credentialsFromEnv,
  defaultExecDeps,
  executeTrade,
  fundUsdt,
  getAssetStatus,
  getLadder,
  getMarketSession,
  listReceipts,
  loadRegistry,
  resolve,
  signedGet,
  sortByGap,
  spentTodayUsd,
  type ExecQuote,
  type ExecReceipt,
  type Outcome,
  type MatrixFlag,
  type Platform,
  type TickerCheck,
  type QuoteFail,
  type SessionName,
  type Verdict,
} from "@gapdesk/core";
import { dateTimes, duration, pct, platformLabel, usd } from "./format";

const FLAG_TEXT: Record<MatrixFlag, string> = {
  NO_PRICE: "NO PRICE",
  NO_REFERENCE: "no ref",
  LARGE_DISPLAYED_GAP: "LARGE GAP",
  STATUS_MISSING: "no session",
  API_ERROR: "API error",
  MULTIPLIER_MISMATCH: "mult mismatch",
};

function flagCell(flags: MatrixFlag[]): string {
  return flags
    .map((f) => {
      const t = FLAG_TEXT[f];
      if (f === "LARGE_DISPLAYED_GAP" || f === "API_ERROR" || f === "NO_PRICE") return pc.red(pc.bold(t));
      if (f === "STATUS_MISSING") return pc.dim(t);
      return pc.yellow(t);
    })
    .join(" ");
}

const SESSION_TEXT: Record<SessionName, string> = {
  premarket: "US pre-market",
  regular: "US regular session",
  postmarket: "US after-hours",
  overnight: "US overnight session",
  closed: "US market closed",
  pause: "Trading paused",
  weekend: "Weekend: NYSE closed, tokens still trade on-chain",
  unknown: "Unknown session",
};

function sessionBadge(s: SessionName): string {
  const text = SESSION_TEXT[s];
  if (s === "regular") return pc.bgGreen(pc.black(` ${text} `));
  if (s === "pause") return pc.bgRed(pc.white(` ${text} `));
  if (s === "weekend" || s === "closed") return pc.bgMagenta(pc.white(` ${text} `));
  return pc.bgYellow(pc.black(` ${text} `));
}

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
const envFile = resolvePath(repoRoot, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const program = new Command()
  .name("gap")
  .description("Executable Gap Desk: tokenized stocks on BSC (Ondo, xStocks, bStocks)");

program
  .command("session")
  .description("Market session for tokenized US stocks, with countdown to the next open/close")
  .option("--asset <query>", "also show per-asset status for every venue of a ticker/symbol")
  .option("--json", "print JSON")
  .action(async (opts: { asset?: string; json?: boolean }) => {
    const now = Date.now();
    const s = await getMarketSession(now);
    let assets: Array<{ symbol: string; platform: string; status: Awaited<ReturnType<typeof getAssetStatus>> }> = [];
    if (opts.asset) {
      const res = resolve(await loadRegistry(), opts.asset);
      if (!res) throw new Error(`No BSC tokenized stock matches "${opts.asset}".`);
      assets = await Promise.all(
        res.venues.map(async (v) => ({ symbol: v.symbol, platform: platformLabel(v.platform), status: await getAssetStatus(v, now) })),
      );
    }
    if (opts.json) {
      console.log(JSON.stringify({ ...s, raw: undefined, assets }, null, 2));
      return;
    }
    console.log(sessionBadge(s.session));
    console.log(`  tradable now     ${s.open ? pc.green("yes") : pc.red("no")}   ${pc.dim(`reasonCode=${s.reasonCode ?? "null"} marketStatus=${s.raw.marketStatus ?? "null"}`)}`);
    if (s.nextEvent) {
      console.log(`  next ${s.nextEvent.type.padEnd(11)} ${pc.bold(`in ${duration(s.nextEvent.at.getTime() - now)}`)}  ${dateTimes(s.nextEvent.at)}`);
    }
    console.log(`  next open        ${dateTimes(s.nextOpen)}`);
    console.log(`  next close       ${dateTimes(s.nextClose)}`);
    if (s.offhours) {
      console.log(`  weekend window   ${s.offhours.open ? pc.green("open") : pc.dim("not active")}  ${dateTimes(s.offhours.nextOpen)}  ->  ${dateTimes(s.offhours.nextClose)}`);
    }
    if (assets.length) {
      const table = new Table({ head: ["Venue", "Platform", "Open", "Session", "Reason", "Note"] });
      for (const a of assets) {
        table.push([
          a.symbol,
          a.platform,
          a.status.open === null ? pc.dim("n/a") : a.status.open ? pc.green("yes") : pc.red("no"),
          a.status.session,
          a.status.reasonCode ?? pc.dim("null"),
          a.status.sessionMissing ? pc.yellow("API returns no session for this venue") : "",
        ]);
      }
      console.log(table.toString());
    }
  });

program
  .command("matrix")
  .description("Displayed per-share gap vs the underlying stock for every venue")
  .option("--multi", "only tickers listed on 2+ platforms (default)")
  .option("--all", "every tokenized stock on BSC")
  .option("--ticker <list...>", "tickers, e.g. NVDA,AAPL,MSTR or NVDA AAPL MSTR")
  .option("--sort <key>", "gap | ticker", "ticker")
  .option("--flagged", "only rows with a flag other than 'no session'")
  .option("--json", "print JSON")
  .action(async (opts: { multi?: boolean; all?: boolean; ticker?: string[]; sort: string; flagged?: boolean; json?: boolean }) => {
    const result = await buildMatrix({
      scope: opts.all ? "all" : "multi",
      // PowerShell turns `NVDA,AAPL` into `NVDA AAPL`, so accept either separator.
      tickers: opts.ticker ? opts.ticker.join(",").split(/[\s,]+/).filter(Boolean) : undefined,
    });
    let rows = opts.sort === "gap" ? sortByGap(result.rows) : result.rows;
    if (opts.flagged) rows = rows.filter((r) => r.flags.some((f) => f !== "STATUS_MISSING"));

    if (opts.json) {
      console.log(JSON.stringify({ ...result, rows, session: result.session ? { ...result.session, raw: undefined } : null }, null, 2));
      return;
    }

    const table = new Table({
      head: ["Ticker", "Platform", "Symbol", "Per share", "Reference", "Displayed gap", "Status", "Flags"],
      colAligns: ["left", "left", "left", "right", "right", "right", "left", "left"],
    });
    let lastTicker = "";
    for (const r of rows) {
      const tickerCell = opts.sort === "gap" || r.ticker !== lastTicker ? pc.bold(r.ticker) : "";
      lastTicker = r.ticker;
      const status = r.error
        ? pc.dim(`[${r.error.code ?? "?"}] ${r.error.message}`.slice(0, 40))
        : r.assetStatus?.reasonCode ?? pc.dim("n/a");
      table.push([
        tickerCell,
        platformLabel(r.platform),
        r.symbol,
        usd(r.perShare),
        r.reference === null ? pc.dim("n/a") : `${usd(r.reference)} ${pc.dim(r.referenceSource)}`,
        pct(r.displayedGapPct),
        status,
        flagCell(r.flags),
      ]);
    }
    console.log(table.toString());

    const { summary: s } = result;
    const sess = result.session ? `${SESSION_TEXT[result.session.session]}` : "session unavailable";
    console.log(
      `${pc.bold(String(s.tickers))} tickers, ${pc.bold(String(s.venues))} venues, ` +
        `${s.flagged ? pc.red(`${s.flagged} flagged`) : pc.green("0 flagged")}, ` +
        `${s.errors ? pc.red(`${s.errors} API errors`) : "0 API errors"} ` +
        pc.dim(`| ${sess} | built in ${(result.elapsedMs / 1000).toFixed(1)}s`),
    );
    console.log(pc.dim("Displayed gap = on-chain price per share vs the underlying US stock. It is not a fill price; Part 2 adds executable quotes."));
  });

program
  .command("resolve")
  .description("Show every BSC venue for a ticker, symbol or contract address")
  .argument("<query>", "e.g. NVDA, NVDAB, AAPLon or 0x...")
  .option("--json", "print JSON")
  .action(async (query: string, opts: { json?: boolean }) => {
    const venues = await loadRegistry();
    const res = resolve(venues, query);
    if (!res) {
      console.error(pc.red(`No BSC tokenized stock matches "${query}".`));
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    const table = new Table({ head: ["Platform", "Symbol", "Contract (BSC)", "Shares per token"] });
    for (const v of res.venues) {
      const mark = res.match && res.match.address === v.address ? pc.cyan(" <") : "";
      table.push([platformLabel(v.platform), v.symbol + mark, v.address, v.multiplier.toFixed(6)]);
    }
    console.log(`${pc.bold(res.ticker)} ${pc.dim(`(matched by ${res.matchedBy})`)}  ${res.venues.length} venue(s) on BSC`);
    console.log(table.toString());
  });

function parseSizes(values: string[] | undefined, fallback: readonly number[]): number[] {
  if (!values?.length) return [...fallback];
  const sizes = values.join(",").split(/[\s,]+/).filter(Boolean).map(Number);
  const bad = sizes.find((n) => !Number.isFinite(n) || n <= 0);
  if (bad !== undefined) throw new Error(`Invalid --usd size: ${bad}`);
  return [...new Set(sizes)].sort((a, b) => a - b);
}

function quoteFailText(q: QuoteFail): string {
  return `${QUOTE_REASON_TEXT[q.reason]} ${pc.dim(`(${q.code ?? "?"})`)}`;
}

program
  .command("quote")
  .description("Executable quotes (USDT -> token) for one venue at one or more sizes")
  .argument("<symbol>", "venue symbol or address, e.g. NVDAB, AAPLon, MSTRx")
  .option("--usd <sizes...>", "USD sizes, e.g. 25 100 500", ["25", "100", "500"])
  .option("--json", "print JSON")
  .action(async (symbol: string, opts: { usd?: string[]; json?: boolean }) => {
    const sizes = parseSizes(opts.usd, DEFAULT_LADDER);
    const res = resolve(await loadRegistry(), symbol);
    if (!res?.match) throw new Error(`"${symbol}" is not a venue symbol or address. Try \`gap resolve ${symbol}\`.`);
    const venue = res.match;
    const { rows } = await buildMatrix({ scope: "all", tickers: [res.ticker], withSession: false });
    const row = rows.find((r) => r.address === venue.address);
    const ladder = await getLadder(venue, sizes, { multiplier: row?.multiplier, reference: row?.reference });
    if (opts.json) {
      console.log(JSON.stringify({ ...ladder, reference: row?.reference ?? null, displayedPerShare: row?.perShare ?? null }, null, 2));
      return;
    }
    console.log(
      `${pc.bold(venue.symbol)} ${pc.dim(platformLabel(venue.platform))}  displayed ${usd(row?.perShare)}/share  reference ${usd(row?.reference)}  ${pc.dim(`multiplier ${row?.multiplier?.toFixed(6) ?? "?"}`)}`,
    );
    const table = new Table({
      head: ["Size", "Mode / vendor", "Tokens out", "Per share", "Exec gap", "Ladder impact", "API impact", "Net fee", "Route"],
      colAligns: ["right", "left", "right", "right", "right", "right", "right", "right", "left"],
    });
    for (const q of ladder.quotes) {
      if (!q.ok) {
        table.push([usd(q.usd, 0), { colSpan: 8, content: pc.red(quoteFailText(q)) }]);
        continue;
      }
      table.push([
        usd(q.usd, 0),
        `${q.executionMode ?? "?"} / ${q.vendorName ?? "?"}`,
        q.tokensOut >= 0.001 ? q.tokensOut.toFixed(6) : q.tokensOut.toPrecision(4),
        usd(q.fillPerShare),
        pct(q.executableGapPct),
        pct(ladder.impactPct[q.usd]),
        pct(q.vendorPriceImpact),
        usd(q.networkFeeUsd, 3),
        q.route.join(" > "),
      ]);
    }
    console.log(table.toString());
  });

function verdictBadge(v: Verdict): string {
  if (v === "GO") return pc.bgGreen(pc.black(" GO "));
  if (v === "CAUTION") return pc.bgYellow(pc.black(" CAUTION "));
  return pc.bgRed(pc.white(pc.bold(" BLOCK ")));
}

function modeCell(q: ExecQuote | null): string {
  if (!q) return pc.dim("no quote");
  if (!q.ok) return pc.red(`${q.reason.toLowerCase().replaceAll("_", " ")} (${q.code ?? "?"})`);
  return `${q.executionMode ?? "?"} / ${q.vendorName ?? "?"}`;
}

program
  .command("check")
  .description("Truth Card: displayed vs executable per share on every venue, with a GO / CAUTION / BLOCK verdict")
  .argument("<ticker>", "underlying ticker, e.g. NVDA, MSTR, AAPL")
  .option("--usd <size>", "trade size in USD", "25")
  .option("--ladder", `also quote $${DEFAULT_POLICY.impactCautionUsd} and $500 so the size-impact rule has data`)
  .option("--json", "print JSON")
  .action(async (tickerArg: string, opts: { usd: string; ladder?: boolean; json?: boolean }) => {
    const size = Number(opts.usd);
    if (!Number.isFinite(size) || size <= 0) throw new Error(`Invalid --usd size: ${opts.usd}`);
    const ticker = resolve(await loadRegistry(), tickerArg)?.ticker ?? tickerArg.toUpperCase();
    const ladderSizes = opts.ladder ? [DEFAULT_POLICY.impactCautionUsd, 500] : [];
    const card = await checkTicker(ticker, { usd: size, ladderSizes });
    if (opts.json) {
      console.log(JSON.stringify({ ...card, marketSession: card.marketSession ? { ...card.marketSession, raw: undefined } : null }, null, 2));
      return;
    }

    const quoteTimes = card.venues.map((v) => v.quote?.ts).filter((t): t is number => t !== undefined);
    const age = quoteTimes.length ? `${Math.round((Date.now() - Math.min(...quoteTimes)) / 1000)}s old` : "no quotes";
    const refSource = card.rows[0]?.referenceSource ?? "none";
    console.log(
      `${pc.bold(card.ticker)}  stock ${usd(card.reference)} ${pc.dim(`(${refSource})`)}  ` +
        `${card.session ? sessionBadge(card.session) : pc.dim("session unknown")}  ${pc.dim(`size ${usd(size, 0)}, quotes ${age}`)}`,
    );

    const impactUsd = DEFAULT_POLICY.impactCautionUsd;
    const head = ["Venue", "Platform", "Displayed", "Disp. gap", "Executable", "Exec. gap", ...(opts.ladder ? [`Impact $${impactUsd}`] : []), "Mode / vendor", "Verdict"];
    const table = new Table({ head, colAligns: ["left", "left", "right", "right", "right", "right", ...(opts.ladder ? ["right" as const] : []), "left", "left"] });
    for (const v of card.venues) {
      const row = card.rows.find((r) => r.symbol === v.symbol);
      table.push([
        card.bestVenue?.symbol === v.symbol ? pc.bold(pc.cyan(`${v.symbol} *`)) : v.symbol,
        platformLabel(v.platform),
        usd(row?.perShare),
        pct(v.displayedGapPct),
        usd(v.fillPerShare),
        pct(v.executableGapPct),
        ...(opts.ladder ? [pct(v.impactPct[impactUsd])] : []),
        modeCell(v.quote),
        verdictBadge(v.verdict),
      ]);
    }
    console.log(table.toString());

    for (const v of card.venues) {
      const shown = v.reasons.filter((r) => r.severity !== "info" || v.verdict === "GO");
      if (!shown.length) continue;
      console.log(`${verdictBadge(v.verdict)} ${pc.bold(v.symbol)}`);
      shown.forEach((r, i) => {
        const color = r.severity === "block" ? pc.red : r.severity === "caution" ? pc.yellow : pc.dim;
        console.log(`   ${i + 1}. ${color(r.message)}`);
      });
    }

    const best = card.bestVenue;
    console.log(
      best
        ? `${pc.bold("Best venue:")} ${pc.cyan(best.symbol)} (${best.verdict}, ${pct(best.executableGapPct)} vs the stock, ${usd(best.fillPerShare)}/share)`
        : pc.red(pc.bold("No safe venue right now.")),
    );
    console.log(pc.dim("Displayed = on-chain token price per share. Executable = what a real quote for this size pays per share."));
  });

const VERDICT_SHORT: Record<Verdict, (s: string) => string> = {
  GO: (s) => pc.green(s),
  CAUTION: (s) => pc.yellow(s),
  BLOCK: (s) => pc.red(s),
};

program
  .command("snapshot")
  .description("Quote every venue at one size (5 req/s), gate each ticker, and summarize where it is safe to trade")
  .option("--all", "every tokenized stock on BSC, not only multi-venue tickers")
  .option("--ticker <list...>", "limit to tickers, e.g. NVDA AAPL MSTR")
  .option("--usd <size>", "trade size in USD", "25")
  .option("--out <file>", "also write the snapshot JSON to a file")
  .option("--json", "print JSON")
  .action(async (opts: { all?: boolean; ticker?: string[]; usd: string; out?: string; json?: boolean }) => {
    const size = Number(opts.usd);
    if (!Number.isFinite(size) || size <= 0) throw new Error(`Invalid --usd size: ${opts.usd}`);
    const tickers = opts.ticker ? opts.ticker.join(",").split(/[\s,]+/).filter(Boolean) : undefined;
    const tty = process.stderr.isTTY;
    const snap = await buildSnapshot({
      scope: opts.all ? "all" : "multi",
      tickers,
      usd: size,
      onProgress: (done, total) => {
        if (tty) process.stderr.write(`\r${pc.dim(`quoting ${done}/${total}`)}`);
        else if (done === total || done % 50 === 0) process.stderr.write(`quoting ${done}/${total}\n`);
      },
    });
    if (tty) process.stderr.write("\r\x1b[K");
    const json = JSON.stringify({ ...snap, session: snap.session ? { ...snap.session, raw: undefined } : null }, null, 2);
    if (opts.out) writeFileSync(opts.out, `${json}\n`);
    if (opts.json) {
      console.log(json);
      return;
    }

    const cell = (t: TickerCheck, platform: Platform) => {
      const v = t.venues.find((x) => x.platform === platform);
      if (!v) return pc.dim("-");
      const detail = v.quote && !v.quote.ok ? `${v.quote.code ?? v.quote.reason}` : v.executableGapPct === null ? v.reasons[0]?.code ?? "" : pct(v.executableGapPct);
      return `${VERDICT_SHORT[v.verdict](v.verdict)} ${detail}`;
    };
    const table = new Table({ head: ["Ticker", "Ondo", "bStocks", "xStocks", "Best venue", "Largest displayed gap"] });
    for (const t of snap.tickers) {
      const loudest = [...t.venues].filter((v) => v.displayedGapPct !== null).sort((a, b) => Math.abs(b.displayedGapPct!) - Math.abs(a.displayedGapPct!))[0];
      table.push([
        pc.bold(t.ticker),
        cell(t, "ondo"),
        cell(t, "bstocks"),
        cell(t, "xstocks"),
        t.bestVenue ? `${pc.cyan(t.bestVenue.symbol)} ${pct(t.bestVenue.executableGapPct)}` : pc.red("none"),
        loudest ? `${loudest.symbol} ${pct(loudest.displayedGapPct)}${loudest.verdict === "BLOCK" ? pc.dim(" (blocked)") : ""}` : pc.dim("n/a"),
      ]);
    }
    console.log(table.toString());
    const s = snap.summary;
    const traps = snap.tickers.flatMap((t) => t.venues).filter((v) => v.displayedGapPct !== null && Math.abs(v.displayedGapPct) >= 0.03 && v.verdict === "BLOCK").length;
    console.log(
      `${pc.bold(String(s.tickers))} tickers, ${pc.bold(String(s.venues))} venues at ${usd(size, 0)}: ` +
        `${pc.green(`${s.go} GO`)}, ${pc.yellow(`${s.caution} CAUTION`)}, ${pc.red(`${s.block} BLOCK`)} ` +
        `(${s.quoteErrors} quote errors). ${s.withBestVenue} tickers have a safe venue. ` +
        `${traps} displayed gaps of 3%+ were blocked. ` +
        pc.dim(`| ${snap.session ? SESSION_TEXT[snap.session.session] : "session unavailable"} | ${(snap.elapsedMs / 1000).toFixed(1)}s`),
    );
    if (opts.out) console.log(pc.dim(`wrote ${opts.out}`));
  });

const receiptsDir = resolvePath(repoRoot, "receipts", "exec");

const OUTCOME_BADGE: Record<Outcome, string> = {
  FILLED: pc.bgGreen(pc.black(" FILLED ")),
  SIMULATED: pc.bgCyan(pc.black(" SIMULATED, NOT BROADCAST ")),
  REFUSED: pc.bgRed(pc.white(pc.bold(" REFUSED "))),
  FAILED: pc.bgRed(pc.white(pc.bold(" FAILED "))),
  PENDING: pc.bgYellow(pc.black(" PENDING ")),
};

async function promptConfirm(summary: string, yes: boolean): Promise<boolean> {
  console.error(`\n${pc.bold(summary)}`);
  if (yes) {
    console.error(pc.dim("--yes given: confirmed."));
    return true;
  }
  if (!process.stdin.isTTY) {
    console.error(pc.yellow("No terminal to confirm in; re-run with --yes to broadcast."));
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${pc.yellow("Type yes to sign and broadcast with the Agentic Wallet:")} `);
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

const stepLog = (step: string, detail?: string) => process.stderr.write(`${pc.dim("·")} ${step}${detail ? pc.dim(`  ${detail}`) : ""}\n`);

function printReceipt(r: ExecReceipt, path: string | null) {
  console.log();
  console.log(`${OUTCOME_BADGE[r.outcome]} ${pc.bold(r.kind === "funding" ? "BNB -> USDT funding" : `${r.symbol}  $${r.usd}`)} ${pc.dim(`(${r.mode})`)}`);
  if (r.refusal) console.log(`  ${pc.red(`${r.refusal.code}: ${r.refusal.message}`)}`);
  if (r.gate) {
    console.log(`  gate        ${verdictBadge(r.gate.verdict)} ${r.gate.session ? SESSION_TEXT[r.gate.session] : ""}  ${pc.dim(`stock ${usd(r.gate.reference)}, displayed ${pct(r.gate.displayedGapPct)}, executable ${pct(r.gate.executableGapPct)}`)}`);
    r.gate.reasons
      .filter((x) => x.severity !== "info")
      .forEach((x, i) => console.log(`              ${i + 1}. ${(x.severity === "block" ? pc.red : pc.yellow)(x.message)}`));
  }
  if (r.quote && r.kind === "trade") {
    console.log(`  quote       ${r.quote.tokensOut.toPrecision(6)} tokens at ${usd(r.quote.fillPerShare)}/share  ${pc.dim(`${r.quote.executionMode} / ${r.quote.vendorName}, ${r.quote.route.join(" > ")}`)}`);
  }
  if (r.approval) {
    const a = r.approval;
    console.log(`  approval    ${a.needed ? `exact ${Number(a.amount) / 1e18} USDT to ${a.spender}` : pc.dim("not needed (allowance covers the trade)")}${a.txHash ? `  ${pc.cyan(a.bscscan ?? a.txHash)}` : ""}`);
  }
  if (r.swap) {
    const worst = r.swap.worstCaseGapPct === null ? "" : pc.dim(`, worst case at ${r.swap.slippagePct}% slippage ${pct(r.swap.worstCaseGapPct)} vs the stock`);
    console.log(`  swap        to ${r.swap.to}${worst}`);
  }
  if (r.simulation) {
    const s = r.simulation;
    const label = s.source === "eth_call-state-override" ? "BSC eth_call with funded/approved state override" : "Binance Transaction API";
    console.log(`  simulation  ${s.status === "SUCCESS" ? pc.green(s.status) : pc.red(s.status)} ${pc.dim(`(${label})`)}${s.failReason ? `  ${pc.red(s.failReason)}` : ""}`);
    if (s.apiFailReason) console.log(pc.dim(`              Transaction API on the real wallet: ${s.apiStatus} (${s.apiFailReason})`));
  }
  if (r.swap?.txHash) console.log(`  tx          ${pc.cyan(r.swap.bscscan ?? r.swap.txHash)}  ${pc.dim(`gas ${r.swap.gasCostBnb?.toFixed(8) ?? "?"} BNB`)}`);
  if (r.fill && r.kind === "trade") {
    const f = r.fill;
    console.log(`  fill        ${f.tokensOut.toPrecision(6)} ${r.symbol} for ${f.usdSpent.toFixed(4)} USDT = ${usd(f.fillPerShare)}/share  quoted ${usd(f.quotedFillPerShare)}  realized vs quoted ${pct(f.realizedVsQuotedPct)}  vs stock ${pct(f.realizedGapPct)}`);
  }
  if (r.fill && r.kind === "funding") console.log(`  received    ${r.fill.tokensOut.toFixed(4)} USDT`);
  if (path) console.log(pc.dim(`  receipt     ${relative(repoRoot, path)}`));
}

program
  .command("exec")
  .description("Buy a venue token with USDT, only on a fresh GO verdict. Dry run unless --live.")
  .argument("<symbol>", "venue symbol, e.g. NVDAB (not a ticker)")
  .requiredOption("--usd <amount>", "USDT to spend")
  .option("--live", "sign and broadcast with the Agentic Wallet (default: dry run)")
  .option("--simulate-only", "explicit dry run; cannot be combined with --live")
  .option("--yes", "skip the typed confirmation (only with --live)")
  .option("--json", "print the receipt JSON")
  .action(async (symbol: string, opts: { usd: string; live?: boolean; simulateOnly?: boolean; yes?: boolean; json?: boolean }) => {
    if (opts.live && opts.simulateOnly) throw new Error("--live and --simulate-only cannot be combined.");
    if (opts.yes && !opts.live) throw new Error("--yes only applies with --live.");
    const live = opts.live === true && process.env.DRY_RUN !== "1";
    if (opts.live && !live) console.error(pc.yellow("DRY_RUN=1 is set; running as a dry run."));
    const { receipt, path } = await executeTrade(symbol, {
      usd: Number(opts.usd),
      live,
      receiptsDir,
      deps: { ...defaultExecDeps(), confirm: (s) => promptConfirm(s, opts.yes === true), log: stepLog },
    });
    if (opts.json) console.log(JSON.stringify(receipt, null, 2));
    else printReceipt(receipt, path);
    if (receipt.outcome !== "FILLED" && receipt.outcome !== "SIMULATED") process.exitCode = 1;
  });

program
  .command("fund")
  .description("One-off: convert native BNB to USDT through the same simulate + Agentic Wallet path (not gated)")
  .requiredOption("--bnb <amount>", "BNB to convert; at least 0.001 BNB is always kept for gas")
  .option("--live", "sign and broadcast (default: dry run)")
  .option("--yes", "skip the typed confirmation (only with --live)")
  .option("--json", "print the receipt JSON")
  .action(async (opts: { bnb: string; live?: boolean; yes?: boolean; json?: boolean }) => {
    if (opts.yes && !opts.live) throw new Error("--yes only applies with --live.");
    const live = opts.live === true && process.env.DRY_RUN !== "1";
    const { receipt, path } = await fundUsdt({
      bnb: Number(opts.bnb),
      live,
      receiptsDir,
      deps: { ...defaultExecDeps(), confirm: (s) => promptConfirm(s, opts.yes === true), log: stepLog },
    });
    if (opts.json) console.log(JSON.stringify(receipt, null, 2));
    else printReceipt(receipt, path);
    if (receipt.outcome !== "FILLED" && receipt.outcome !== "SIMULATED") process.exitCode = 1;
  });

program
  .command("receipts")
  .description("List execution receipts (live fills, simulations and refusals)")
  .option("--json", "print JSON")
  .action((opts: { json?: boolean }) => {
    const all = listReceipts(receiptsDir);
    if (opts.json) {
      console.log(JSON.stringify(all, null, 2));
      return;
    }
    if (!all.length) {
      console.log(pc.dim(`No receipts yet in ${relative(repoRoot, receiptsDir)}.`));
      return;
    }
    const table = new Table({ head: ["Time (UTC)", "What", "Mode", "Outcome", "Gate", "Fill/share", "vs quote", "Tx or reason"] });
    for (const r of all) {
      table.push([
        r.createdAt.slice(0, 19).replace("T", " "),
        r.kind === "funding" ? `fund $${r.usd} USDT` : `${r.symbol} $${r.usd}`,
        r.mode,
        OUTCOME_BADGE[r.outcome],
        r.gate ? VERDICT_SHORT[r.gate.verdict](r.gate.verdict) : pc.dim("-"),
        r.fill?.fillPerShare ? usd(r.fill.fillPerShare) : pc.dim("-"),
        r.fill?.realizedVsQuotedPct !== undefined && r.fill?.realizedVsQuotedPct !== null ? pct(r.fill.realizedVsQuotedPct) : pc.dim("-"),
        r.swap?.txHash ? pc.cyan(r.swap.txHash.slice(0, 18) + "…") : r.refusal ? pc.red(r.refusal.code) : pc.dim("-"),
      ]);
    }
    console.log(table.toString());
    console.log(pc.dim(`Live USDT spent on fills today: $${spentTodayUsd(all, Date.now()).toFixed(2)} of $${DEFAULT_POLICY.maxDailySpendUsd}.`));
  });

program
  .command("ping")
  .description("Check the keyed Binance Web3 API credentials in .env.local with a signed request")
  .option("--json", "print JSON")
  .action(async (opts: { json?: boolean }) => {
    const creds = credentialsFromEnv();
    const started = Date.now();
    const data = await signedGet("/api/v1/dex/aggregator/supported/chain", creds);
    const ms = Date.now() - started;
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, latencyMs: ms, data }, null, 2));
      return;
    }
    const chains = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    const names = chains.map((c) => String(c.shortName ?? c.name ?? c.binanceChainId ?? "?"));
    const bsc = chains.some((c) => String(c.binanceChainId ?? "") === CHAIN_ID);
    console.log(`${pc.green("signed request OK")} ${pc.dim(`key ${creds.apiKey.slice(0, 4)}…${creds.apiKey.slice(-4)}, ${ms} ms`)}`);
    console.log(`  supported chains  ${names.length ? names.join(", ") : pc.dim(JSON.stringify(data).slice(0, 120))}`);
    if (chains.length) console.log(`  BSC (56)          ${bsc ? pc.green("supported") : pc.red("not listed")}`);
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof MissingCredentialsError) {
    console.error(pc.yellow(err.message));
    process.exit(2);
  }
  if (err instanceof ApiError) {
    console.error(pc.red(`API error on ${err.endpoint}: [${err.code ?? err.httpStatus ?? "network"}] ${err.message}`));
  } else {
    console.error(pc.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  }
  process.exit(1);
});
