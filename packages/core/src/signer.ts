import { createHmac } from "node:crypto";
import { KEYED_HOST, KEYED_PREFIX } from "./config";
import { getJson, type GetJsonOptions } from "./http";

export interface Credentials {
  apiKey: string;
  apiSecret: string;
}

export class MissingCredentialsError extends Error {
  constructor() {
    super("BW3_API_KEY / BW3_API_SECRET are not set. Copy .env.example to .env.local and fill them in.");
    this.name = "MissingCredentialsError";
  }
}

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials {
  const apiKey = env.BW3_API_KEY?.trim();
  const apiSecret = env.BW3_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new MissingCredentialsError();
  return { apiKey, apiSecret };
}

/** `/api/v1/...` becomes `/build/api/v1/...`; paths that already carry the prefix are left alone. */
export function withBuildPrefix(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p.startsWith(`${KEYED_PREFIX}/`) ? p : `${KEYED_PREFIX}${p}`;
}

/**
 * preHash = timestamp + METHOD + requestPath + body, where requestPath is the exact wire path
 * including `/build` and the raw query string. Omitting `/build` is the documented #1 cause of 40102.
 */
export function buildPreHash(timestamp: string, method: string, requestPath: string, body = ""): string {
  return `${timestamp}${method.toUpperCase()}${requestPath}${body}`;
}

export function sign(preHash: string, secret: string): string {
  return createHmac("sha256", secret).update(preHash, "utf8").digest("base64");
}

export function signedHeaders(
  method: string,
  pathWithQuery: string,
  creds: Credentials,
  body = "",
  now: Date = new Date(),
): Record<string, string> {
  const timestamp = now.toISOString();
  const requestPath = withBuildPrefix(pathWithQuery);
  return {
    "X-OC-APIKEY": creds.apiKey,
    "X-OC-TIMESTAMP": timestamp,
    "X-OC-SIGN": sign(buildPreHash(timestamp, method, requestPath, body), creds.apiSecret),
  };
}

/**
 * Signed GET against the keyed Web3 API. No automatic retries: the signature doubles as a
 * single-use nonce (replays fail with 40103), so a retry must be re-signed by the caller.
 */
export async function signedGet(
  pathWithQuery: string,
  creds: Credentials = credentialsFromEnv(),
  opts: Omit<GetJsonOptions, "headers"> = {},
): Promise<unknown> {
  const requestPath = withBuildPrefix(pathWithQuery);
  return getJson(`${KEYED_HOST}${requestPath}`, {
    ...opts,
    retries: 0,
    endpoint: opts.endpoint ?? requestPath.split("?")[0],
    headers: signedHeaders("GET", requestPath, creds),
  });
}
