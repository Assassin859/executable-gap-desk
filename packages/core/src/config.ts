export const PUBLIC_BASE = "https://www.binance.com/bapi/defi";
export const KEYED_HOST = "https://web3.binance.com";
/** Every keyed request path, and the signed requestPath, must start with this prefix. */
export const KEYED_PREFIX = "/build";

export const PUBLIC_HEADERS: Record<string, string> = {
  "User-Agent": "binance-web3/1.1 (Skill)",
  "Accept-Encoding": "identity",
};

export const CHAIN_ID = "56";
export const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";

export const ENDPOINTS = {
  list: "/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai",
  meta: "/v1/public/wallet-direct/buw/wallet/market/token/rwa/meta/ai",
  marketStatus: "/v1/public/wallet-direct/buw/wallet/market/token/rwa/market/status/ai",
  assetStatus: "/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai",
  dynamic: "/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai",
  kline: "/v1/public/wallet-direct/buw/wallet/dex/market/token/kline/ai",
} as const;

export type Platform = "ondo" | "xstocks" | "bstocks";

/** The list API's `type` field is undocumented beyond 1 = Ondo; 2 and 3 were mapped by symbol suffix (`x`, `B`). */
export const PLATFORM_BY_TYPE: Readonly<Record<number, Platform>> = {
  1: "ondo",
  2: "xstocks",
  3: "bstocks",
};

export const PLATFORM_LABEL: Readonly<Record<Platform, string>> = {
  ondo: "Ondo",
  xstocks: "xStocks",
  bstocks: "bStocks",
};

export const PLATFORM_ORDER: readonly Platform[] = ["ondo", "bstocks", "xstocks"];

export const publicUrl = (endpoint: string, params?: Record<string, string>): string => {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
  return `${PUBLIC_BASE}${endpoint}${qs}`;
};
