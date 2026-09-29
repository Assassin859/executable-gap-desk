/**
 * Records live Binance responses into packages/core/test/fixtures so tests run offline.
 * Usage:
 *   pnpm record-fixtures            public RWA data (list, market status, dynamic, asset status)
 *   pnpm record-fixtures --quotes   signed aggregator quotes for the fixture venues (needs .env.local;
 *                                   record during the US regular session)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApiError,
  CHAIN_ID,
  ENDPOINTS,
  ListSchema,
  PUBLIC_HEADERS,
  credentialsFromEnv,
  getJson,
  parseRegistry,
  publicUrl,
  quoteLimiter,
  quotePath,
  signedGet,
} from "../packages/core/src/index";

const TICKERS = new Set(["AAPL", "NVDA", "MSTR", "SPY"]);
const LADDER_SYMBOLS = new Set(["NVDAB", "AAPLon"]);
const LADDER_SIZES = [100, 500];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "packages/core/test/fixtures");

type RawItem = { chainId: string | number; contractAddress: string; symbol: string; ticker: string; type: number | string };

const get = (endpoint: string, params?: Record<string, string>) =>
  getJson(publicUrl(endpoint, params), { headers: PUBLIC_HEADERS, endpoint });

const save = (name: string, data: unknown) => {
  writeFileSync(resolve(outDir, name), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${name}`);
};

async function recordPublic() {
  const list = (await get(ENDPOINTS.list)) as RawItem[];
  const bscTargets = list.filter((i) => String(i.chainId) === CHAIN_ID && TICKERS.has(i.ticker) && [1, 2, 3].includes(Number(i.type)));
  // Keep a few rows the registry must discard: another chain, and an unsupported platform type.
  const otherChain = list.find((i) => String(i.chainId) !== CHAIN_ID && TICKERS.has(i.ticker));
  const otherType = list.find((i) => String(i.chainId) === CHAIN_ID && ![1, 2, 3].includes(Number(i.type)));
  save("list.json", [...bscTargets, otherChain, otherType].filter(Boolean));

  save("market-status.json", await get(ENDPOINTS.marketStatus));

  const dynamic: Record<string, unknown> = {};
  const assetStatus: Record<string, unknown> = {};
  for (const item of bscTargets) {
    const params = { chainId: CHAIN_ID, contractAddress: item.contractAddress };
    dynamic[item.symbol] = await get(ENDPOINTS.dynamic, params);
    if (item.ticker === "NVDA") assetStatus[item.symbol] = await get(ENDPOINTS.assetStatus, params);
  }
  save("dynamic.json", dynamic);
  save("asset-status.json", assetStatus);
  save("meta.json", { recordedAt: new Date().toISOString(), tickers: [...TICKERS], venues: bscTargets.length });
}

/** Quote ids are single-use and expire in 30s; replace them so fixtures never look replayable. */
const stripQuoteIds = (data: unknown) =>
  Array.isArray(data) ? data.map((r) => (r && typeof r === "object" ? { ...r, quoteId: "fixture" } : r)) : data;

async function recordQuotes() {
  const envFile = resolve(root, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const creds = credentialsFromEnv();
  const wallet = process.env.GAP_WALLET_ADDRESS;
  if (!wallet) throw new Error("GAP_WALLET_ADDRESS is not set in .env.local");

  const venues = parseRegistry(ListSchema.parse(JSON.parse(readFileSync(resolve(outDir, "list.json"), "utf8"))));
  const jobs = venues.flatMap((v) => [25, ...(LADDER_SYMBOLS.has(v.symbol) ? LADDER_SIZES : [])].map((usd) => ({ v, usd })));
  const quotes: Record<string, unknown> = {};
  await Promise.all(
    jobs.map(async ({ v, usd }) => {
      const key = `${v.symbol}@${usd}`;
      try {
        const data = await signedGet(quotePath(v.address, usd, wallet), creds, { limiter: quoteLimiter, endpoint: "/quote" });
        quotes[key] = { ok: true, data: stripQuoteIds(data) };
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        quotes[key] = { ok: false, httpStatus: err.httpStatus, code: err.code, msg: err.message };
      }
      console.log(key, (quotes[key] as { ok: boolean }).ok ? "ok" : `error ${(quotes[key] as { code: unknown }).code}`);
    }),
  );
  const sorted = Object.fromEntries(Object.entries(quotes).sort(([a], [b]) => a.localeCompare(b)));
  save("quotes.json", { recordedAt: new Date().toISOString(), wallet: "redacted", quotes: sorted });
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  if (process.argv.includes("--quotes")) await recordQuotes();
  else await recordPublic();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
