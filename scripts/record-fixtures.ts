/**
 * Records live Binance RWA responses into packages/core/test/fixtures so tests run offline.
 * Usage: pnpm record-fixtures
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_ID, ENDPOINTS, PUBLIC_HEADERS, getJson, publicUrl } from "../packages/core/src/index";

const TICKERS = new Set(["AAPL", "NVDA", "MSTR", "SPY"]);
const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/core/test/fixtures");

type RawItem = { chainId: string | number; contractAddress: string; symbol: string; ticker: string; type: number | string };

const get = (endpoint: string, params?: Record<string, string>) =>
  getJson(publicUrl(endpoint, params), { headers: PUBLIC_HEADERS, endpoint });

const save = (name: string, data: unknown) => {
  writeFileSync(resolve(outDir, name), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${name}`);
};

async function main() {
  mkdirSync(outDir, { recursive: true });

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
