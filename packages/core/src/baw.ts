import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { CHAIN_ID } from "./config";

export interface BawResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type BawRunner = (args: string[]) => Promise<BawResult>;

export class BawError extends Error {
  readonly body: unknown;
  constructor(msg: string, body?: unknown) {
    super(msg);
    this.name = "BawError";
    this.body = body;
  }
}

/** baw answered with `success: false`: the request was refused. A timeout or unreadable output is not a rejection. */
export const isBawRejection = (e: unknown): e is BawError =>
  e instanceof BawError && typeof e.body === "object" && e.body !== null && (e.body as { success?: unknown }).success === false;

/**
 * On Windows `baw` is an npm .cmd shim, and spawning .cmd files requires a shell that would
 * concatenate calldata into a command line. Run the package's JS entry with node instead.
 */
export function resolveBaw(env: NodeJS.ProcessEnv = process.env): { cmd: string; prefix: string[] } {
  if (env.BAW_BIN) return env.BAW_BIN.endsWith(".js") ? { cmd: process.execPath, prefix: [env.BAW_BIN] } : { cmd: env.BAW_BIN, prefix: [] };
  if (process.platform !== "win32") return { cmd: "baw", prefix: [] };
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir || !existsSync(join(dir, "baw.cmd"))) continue;
    const entry = join(dir, "node_modules", "@binance", "agentic-wallet", "dist", "index.js");
    if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry] };
  }
  const appData = env.APPDATA ? join(env.APPDATA, "npm", "node_modules", "@binance", "agentic-wallet", "dist", "index.js") : "";
  if (appData && existsSync(appData)) return { cmd: process.execPath, prefix: [appData] };
  throw new BawError("baw not found. Install it with `npm i -g @binance/agentic-wallet` or set BAW_BIN.");
}

export function createBawRunner(timeoutMs = 120_000): BawRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      let bin: { cmd: string; prefix: string[] };
      try {
        bin = resolveBaw();
      } catch (err) {
        reject(err);
        return;
      }
      const child = spawn(/*turbopackIgnore: true*/ bin.cmd, [...bin.prefix, ...args], { shell: false, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
}

const NUMBER_TOKEN = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Wraps integer literals beyond 2^53 in quotes so JSON.parse keeps their printed digits.
 * Works on any Node version (the reviver's `context.source` only exists from Node 22).
 */
export function quoteUnsafeIntegers(json: string): string {
  let out = "";
  let i = 0;
  while (i < json.length) {
    const ch = json[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      out += json.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      NUMBER_TOKEN.lastIndex = i;
      const tok = NUMBER_TOKEN.exec(json)?.[0];
      if (tok) {
        const integer = !/[.eE]/.test(tok);
        out += integer && !Number.isSafeInteger(Number(tok)) ? `"${tok}"` : tok;
        i += tok.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * `baw --json` prints one JSON object. On Windows it can then crash with a libuv assertion
 * (exit 0xC0000409) after printing, so the exit code alone is not trusted. Integers beyond 2^53
 * come back as strings of their printed digits; `baw` itself already rounds some amounts before
 * printing (DX #28).
 */
export function parseBawOutput(r: BawResult): unknown {
  const start = r.stdout.indexOf("{");
  const end = r.stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new BawError(`baw returned no JSON (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  let json: { success?: boolean; data?: unknown; message?: unknown; msg?: unknown; error?: unknown; code?: unknown };
  try {
    json = JSON.parse(quoteUnsafeIntegers(r.stdout.slice(start, end + 1)));
  } catch {
    throw new BawError(`baw returned invalid JSON (exit ${r.code})`);
  }
  if (json.success === false) {
    const err = json.error as { message?: unknown; code?: unknown } | string | undefined;
    const msg = typeof err === "string" ? err : String(err?.message ?? json.message ?? json.msg ?? "baw error");
    const code = typeof err === "object" && err?.code !== undefined ? ` (${String(err.code)})` : json.code !== undefined ? ` (${String(json.code)})` : "";
    throw new BawError(`${msg}${code}`, json);
  }
  return json.data ?? json;
}

export interface ContractCall {
  from: string;
  to: string;
  value: string;
  data: string;
}

export interface ContractCallPreview {
  requestId: string;
  requireConfirmation: boolean;
  expiresAt: number | null;
  /** `simulationCode` "000000000" means the wallet's own simulation passed. */
  simulationOk: boolean;
  simulationError: string | null;
  risks: unknown[];
  raw: unknown;
}

export function contractCallArgs(c: ContractCall): string[] {
  return ["contract-call", "preview", "--binanceChainId", CHAIN_ID, "--from", c.from, "--to", c.to, "--value", c.value, "--inputData", c.data, "--json"];
}

export function toPreview(data: unknown): ContractCallPreview {
  const d = (data ?? {}) as {
    requestId?: string;
    requireConfirmation?: boolean;
    expiresAt?: number | string;
    simulationResult?: { simulationCode?: string; simulationErrorDetail?: unknown };
    risks?: { riskDetails?: unknown[]; riskBehaviors?: unknown[] };
  };
  if (!d.requestId) throw new BawError("baw preview returned no requestId (the call was intercepted or failed)", data);
  const code = d.simulationResult?.simulationCode;
  const detail = d.simulationResult?.simulationErrorDetail;
  return {
    requestId: d.requestId,
    requireConfirmation: d.requireConfirmation === true,
    expiresAt: d.expiresAt === undefined ? null : Number(d.expiresAt),
    simulationOk: code === undefined || /^0+$/.test(code),
    simulationError: detail ? (typeof detail === "string" ? detail : JSON.stringify(detail)) : null,
    risks: [...(d.risks?.riskDetails ?? []), ...(d.risks?.riskBehaviors ?? [])],
    raw: data,
  };
}

export async function previewContractCall(c: ContractCall, run: BawRunner = createBawRunner()): Promise<ContractCallPreview> {
  return toPreview(parseBawOutput(await run(contractCallArgs(c))));
}

export interface ContractCallResult {
  status: string;
  txHash: string | null;
  raw: unknown;
}

export function toExecuteResult(data: unknown): ContractCallResult {
  const d = (data ?? {}) as { status?: string; txHash?: string; hash?: string; transactionHash?: string };
  return { status: String(d.status ?? "UNKNOWN"), txHash: d.txHash ?? d.hash ?? d.transactionHash ?? null, raw: data };
}

export async function executeContractCall(requestId: string, run: BawRunner = createBawRunner()): Promise<ContractCallResult> {
  return toExecuteResult(parseBawOutput(await run(["contract-call", "execute", "--requestId", requestId, "--json"])));
}

/** After PENDING_CONFIRMATION the hash is unknown until the user approves in the app; find it in history. */
export async function findTxSince(
  sinceMs: number,
  to: string,
  run: BawRunner = createBawRunner(),
): Promise<string | null> {
  const data = parseBawOutput(await run(["wallet", "tx-history", "--binanceChainId", CHAIN_ID, "--startTime", String(sinceMs), "--size", "20", "--json"])) as {
    transactions?: Array<{ txHash?: string; txTime?: string; txType?: string; raw?: unknown; toAddress?: string }>;
  };
  const target = to.toLowerCase();
  const txs = data.transactions ?? [];
  const hit = txs.find((t) => JSON.stringify(t).toLowerCase().includes(target)) ?? txs.find((t) => t.txType !== "transfer");
  return hit?.txHash ?? null;
}
