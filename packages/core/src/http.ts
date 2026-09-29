export class ApiError extends Error {
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly code: string | number | null;
  readonly body: unknown;

  constructor(opts: {
    endpoint: string;
    httpStatus: number | null;
    code: string | number | null;
    msg: string;
    body?: unknown;
  }) {
    super(opts.msg);
    this.name = "ApiError";
    this.endpoint = opts.endpoint;
    this.httpStatus = opts.httpStatus;
    this.code = opts.code;
    this.body = opts.body;
  }

  get retryable(): boolean {
    return this.httpStatus === null || this.httpStatus === 429 || this.httpStatus >= 500;
  }
}

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run) run();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

export const defaultLimiter = createLimiter(8);

export const passthroughLimiter: Limiter = (task) => task();

/**
 * Token bucket: at most `burst` tasks start immediately, then one every 1000/rps ms.
 * Tasks start in call order; it limits start rate, not concurrency.
 */
export function createRateLimiter(rps: number, burst: number = rps): Limiter {
  let tokens = burst;
  let last = Date.now();
  let chain: Promise<void> = Promise.resolve();
  const take = async () => {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - last) * rps) / 1000);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - tokens) * 1000) / rps));
    }
  };
  return <T>(task: () => Promise<T>) => {
    const slot = chain.then(take);
    chain = slot.catch(() => undefined);
    return slot.then(task);
  };
}

/**
 * The keyed API allows 5 requests per 1s window per endpoint. A 5-token burst plus refill can put
 * 9 requests in one window (live 42900s), so quotes are evenly spaced with no burst, with headroom for jitter.
 */
export const quoteLimiter = createRateLimiter(4.5, 1);

export interface GetJsonOptions {
  method?: "GET" | "POST";
  /** Pre-serialized JSON body; sent with `Content-Type: application/json`. */
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  limiter?: Limiter;
  /** Label used in errors instead of the full URL (keeps query strings with addresses out of logs). */
  endpoint?: string;
}

const SUCCESS_CODES = new Set<unknown>(["000000", 0, "0"]);

/**
 * Unwraps both Binance envelopes: public `{code: "000000", data, success}` and keyed
 * `{code: 0, msg, data, success}`. Anything else becomes an ApiError.
 */
export function unwrapEnvelope(endpoint: string, httpStatus: number, json: unknown): unknown {
  if (json === null || typeof json !== "object" || !("data" in json || "code" in json)) {
    return json;
  }
  const env = json as { code?: unknown; success?: unknown; msg?: unknown; message?: unknown; data?: unknown };
  if (env.success === false || (env.code !== undefined && !SUCCESS_CODES.has(env.code))) {
    const code = typeof env.code === "string" || typeof env.code === "number" ? env.code : null;
    const msg = String(env.msg ?? env.message ?? "Unknown API error");
    throw new ApiError({ endpoint, httpStatus, code, msg, body: json });
  }
  return env.data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url: string, opts: GetJsonOptions = {}): Promise<unknown> {
  const { headers = {}, timeoutMs = 8000, retries = 3, limiter = defaultLimiter, method = "GET", body } = opts;
  const endpoint = opts.endpoint ?? new URL(url).pathname;
  const init: RequestInit = { method, headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" } };
  if (body !== undefined) init.body = body;

  let attempt = 0;
  for (;;) {
    try {
      return await limiter(() => fetchOnce(url, endpoint, init, timeoutMs));
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : toNetworkError(endpoint, err);
      if (!apiErr.retryable || attempt >= retries) throw apiErr;
      attempt++;
      await sleep(250 * 2 ** (attempt - 1) + Math.random() * 200);
    }
  }
}

async function fetchOnce(
  url: string,
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError({
      endpoint,
      httpStatus: res.status,
      code: null,
      msg: `Non-JSON response (HTTP ${res.status})`,
      body: text.slice(0, 500),
    });
  }
  if (!res.ok) {
    const env = (json ?? {}) as { code?: unknown; msg?: unknown; message?: unknown };
    const code = typeof env.code === "string" || typeof env.code === "number" ? env.code : null;
    throw new ApiError({
      endpoint,
      httpStatus: res.status,
      code,
      msg: String(env.msg ?? env.message ?? `HTTP ${res.status}`),
      body: json,
    });
  }
  return unwrapEnvelope(endpoint, res.status, json);
}

function toNetworkError(endpoint: string, err: unknown): ApiError {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return new ApiError({ endpoint, httpStatus: null, code: null, msg });
}
