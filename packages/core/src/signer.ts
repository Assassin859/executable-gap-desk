import { createHmac } from "node:crypto";
import { KEYED_HOST, KEYED_PREFIX } from "./config";
import { ApiError, getJson, passthroughLimiter, type GetJsonOptions } from "./http";

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

export interface SignedGetOptions extends Omit<GetJsonOptions, "headers"> {
  /** Base delay for retry backoff; tests shrink it. */
  backoffMs?: number;
}

/**
 * Signed GET against the keyed Web3 API. The signature doubles as a single-use nonce (replays
 * fail with 40103) and the timestamp window is 5s, so every attempt is signed inside its limiter
 * slot, and retries on 429/5xx/network errors are re-signed.
 */
export async function signedGet(
  pathWithQuery: string,
  creds: Credentials = credentialsFromEnv(),
  opts: SignedGetOptions = {},
): Promise<unknown> {
  const { limiter = passthroughLimiter, retries = 2, backoffMs = 300, ...rest } = opts;
  const requestPath = withBuildPrefix(pathWithQuery);
  const endpoint = opts.endpoint ?? requestPath.split("?")[0];
  for (let attempt = 0; ; attempt++) {
    try {
      return await limiter(() =>
        getJson(`${KEYED_HOST}${requestPath}`, {
          ...rest,
          retries: 0,
          limiter: passthroughLimiter,
          endpoint,
          headers: signedHeaders("GET", requestPath, creds),
        }),
      );
    } catch (err) {
      if (!(err instanceof ApiError) || !err.retryable || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt + Math.random() * 100));
    }
  }
}
