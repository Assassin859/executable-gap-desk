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

export interface GetJsonOptions {
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
  const { headers = {}, timeoutMs = 8000, retries = 3, limiter = defaultLimiter } = opts;
  const endpoint = opts.endpoint ?? new URL(url).pathname;

  let attempt = 0;
  for (;;) {
    try {
      return await limiter(() => fetchOnce(url, endpoint, headers, timeoutMs));
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
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
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
