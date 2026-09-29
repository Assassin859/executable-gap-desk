#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import Table from "cli-table3";
import pc from "picocolors";
import {
  ApiError,
  CHAIN_ID,
  MissingCredentialsError,
  buildMatrix,
  credentialsFromEnv,
  getAssetStatus,
  getMarketSession,
  loadRegistry,
  resolve,
  signedGet,
  sortByGap,
  type MatrixFlag,
  type SessionName,
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
