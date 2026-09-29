import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { x402Fetch, type X402Deps, type X402Receipt } from "./x402";
import type { Policy } from "./gate";

/** BNB Chain Agent Studio's stock-analysis agent: paid by x402, asynchronous, one Markdown report per job. */
export const STOCK_AGENT_URL = "https://stock-agent.bnbchain.org";
export const RESEARCH_POLL_MS = 15_000;
export const RESEARCH_TIMEOUT_MS = 10 * 60_000;

export const ResearchPriceSchema = z.looseObject({
  price_u: z.string().optional(),
  price_wei: z.string().optional(),
  asset: z.string().optional(),
  payTo: z.string().optional(),
  accepts: z.array(z.unknown()).default([]),
  facilitator: z.string().optional(),
});
export type ResearchPrice = z.infer<typeof ResearchPriceSchema>;

export async function researchPrice(f: typeof fetch = fetch): Promise<ResearchPrice> {
  const res = await f(`${STOCK_AGENT_URL}/x402/price`);
  if (!res.ok) throw new Error(`GET /x402/price answered HTTP ${res.status}`);
  return ResearchPriceSchema.parse(await res.json());
}

export interface ResearchSummary {
  rating: string | null;
  targetPriceUsd: number | null;
  /** Percent, signed (+ upside, - downside), as the report states it. */
  upsidePct: number | null;
  risks: string[];
}

export interface ResearchJob {
  version: 1;
  /** File id in `receipts/research/`. */
  id: string;
  createdAt: string;
  symbols: string[];
  analysisType: string;
  jobId: string | null;
  /** Needed to poll and download; replaced by `jobTokenSha256` once the report is saved. */
  jobToken?: string;
  jobTokenSha256?: string;
  x402ReceiptId: string | null;
  paid: { amount: string; token: string; settlementTx: string | null } | null;
  /** "submitted" locally, then the server's status (queued, running, succeeded, failed). */
  status: string;
  polls: number;
  lastPolledAt: string | null;
  error: string | null;
  reportFile: string | null;
  summary: ResearchSummary | null;
  /** Submit response kept verbatim when it could not be parsed, so nothing paid for is lost. */
  submitRaw?: string;
  lastPoll?: unknown;
}

const pickStr = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return null;
};

export function researchJobId(symbols: string[], now: number): string {
  return `${new Date(now).toISOString().replace(/[:.]/g, "-")}-research-${symbols.join("-").replace(/[^A-Za-z0-9-]/g, "")}`;
}

export function writeResearchJob(dir: string, job: ResearchJob): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${job.id}.json`);
  writeFileSync(path, `${JSON.stringify(job, null, 2)}\n`);
  return path;
}

export function readResearchJob(path: string): ResearchJob {
  return JSON.parse(readFileSync(path, "utf8")) as ResearchJob;
}

const SYMBOL = /^[A-Z][A-Z.]{0,9}$/;

export interface SubmitOptions {
  live?: boolean;
  analysisType?: string;
  policy?: Policy;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<X402Deps>;
  /** `receipts/research`; the job file is written here the moment the server answers. */
  researchDir: string | null;
  x402Dir: string | null;
  prior?: X402Receipt[];
}

export interface SubmitResult {
  receipt: X402Receipt | null;
  x402Path: string | null;
  job: ResearchJob | null;
  jobPath: string | null;
  /** Set when the call did not reach a paid job (dry run, refusal, failure). */
  httpStatus: number;
}

/**
 * Pays for one analysis job and saves `{jobId, jobToken}` before anything else: the agent has no
 * "list my jobs" endpoint, so a lost token means a lost report, and re-submitting pays twice.
 */
export async function submitResearch(symbols: string[], opts: SubmitOptions): Promise<SubmitResult> {
  const syms = symbols.map((s) => s.trim().toUpperCase());
  if (!syms.length || syms.length > 5 || !syms.every((s) => SYMBOL.test(s))) throw new Error(`Give 1 to 5 stock tickers (e.g. NVDA), got ${symbols.join(" ")}.`);
  const analysisType = opts.analysisType ?? "comprehensive";
  const { res, receipt, path } = await x402Fetch(
    `${STOCK_AGENT_URL}/x402/analyze/async`,
    { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ symbols: syms, analysis_type: analysisType }) },
    { label: `research ${syms.join(" ")}`, live: opts.live, policy: opts.policy, env: opts.env, deps: opts.deps, receiptsDir: opts.x402Dir, prior: opts.prior },
  );
  const paidOrFree = receipt ? receipt.outcome === "PAID" : res.ok;
  if (!paidOrFree) return { receipt, x402Path: path, job: null, jobPath: null, httpStatus: res.status };

  const now = (opts.deps?.now ?? Date.now)();
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // kept verbatim below
  }
  const jobId = pickStr(body, ["jobId", "job_id", "id"]);
  const jobToken = pickStr(body, ["jobToken", "job_token", "token"]);
  const job: ResearchJob = {
    version: 1,
    id: researchJobId(syms, now),
    createdAt: new Date(now).toISOString(),
    symbols: syms,
    analysisType,
    jobId,
    ...(jobToken ? { jobToken } : {}),
    x402ReceiptId: receipt?.id ?? null,
    paid: receipt?.option ? { amount: receipt.option.amount, token: receipt.option.token, settlementTx: receipt.settlement?.transaction ?? null } : null,
    status: jobId && jobToken ? "submitted" : "unparsed",
    polls: 0,
    lastPolledAt: null,
    error: jobId && jobToken ? null : "The paid response had no jobId/jobToken; the raw body is kept in submitRaw.",
    reportFile: null,
    summary: null,
    ...(jobId && jobToken ? {} : { submitRaw: text.slice(0, 4000) }),
  };
  const jobPath = opts.researchDir ? writeResearchJob(opts.researchDir, job) : null;
  return { receipt, x402Path: path, job, jobPath, httpStatus: res.status };
}

export interface PollDeps {
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(step: string, detail?: string): void;
}

export interface PollOptions {
  researchDir: string | null;
  deps?: Partial<PollDeps>;
  intervalMs?: number;
  timeoutMs?: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const DONE = new Set(["succeeded", "success", "completed", "done"]);
const FAILED = new Set(["failed", "error", "cancelled", "canceled", "expired"]);

/**
 * Polls a paid job until it succeeds or fails, saving the job file after every poll. On success the
 * Markdown report is downloaded next to it, summarized, and the job token is replaced by its hash.
 * A timeout leaves the job resumable; it never re-submits.
 */
export async function pollResearch(input: ResearchJob, opts: PollOptions): Promise<{ job: ResearchJob; report: string | null }> {
  const d: PollDeps = { fetch: globalThis.fetch.bind(globalThis), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, log: () => {}, ...opts.deps };
  const job: ResearchJob = structuredClone(input);
  const save = () => (opts.researchDir ? writeResearchJob(opts.researchDir, job) : null);
  if (!job.jobId || !job.jobToken) throw new Error(`Job ${job.id} has no ${job.jobId ? "job token (already downloaded?)" : "job id"} to poll with.`);
  const headers = { "X-Job-Token": job.jobToken, Accept: "application/json" };
  const deadline = d.now() + (opts.timeoutMs ?? RESEARCH_TIMEOUT_MS);
  const interval = opts.intervalMs ?? RESEARCH_POLL_MS;
  for (;;) {
    const res = await d.fetch(`${STOCK_AGENT_URL}/x402/jobs/${encodeURIComponent(job.jobId)}`, { headers }).catch((e: unknown) => e);
    job.polls += 1;
    job.lastPolledAt = new Date(d.now()).toISOString();
    if (res instanceof Response) {
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      job.lastPoll = body;
      if (!res.ok) job.error = `poll HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`;
      else if (body) {
        const status = String(body.status ?? body.state ?? "unknown").toLowerCase();
        job.status = status;
        job.error = null;
        d.log("job", status);
        if (DONE.has(status)) {
          const url = pickStr(body, ["downloadUrl", "download_url", "reportUrl", "url"]);
          const inline = pickStr(body, ["report", "markdown", "result"]);
          const report = url ? await download(d, url, job.jobToken) : inline;
          if (!report) {
            job.error = "The job succeeded but gave no report or download URL.";
            save();
            return { job, report: null };
          }
          const file = `${job.id}.md`;
          if (opts.researchDir) writeFileSync(join(opts.researchDir, file), report.endsWith("\n") ? report : `${report}\n`);
          job.reportFile = file;
          job.summary = summarizeReport(report);
          job.jobTokenSha256 = sha256(job.jobToken);
          delete job.jobToken;
          job.lastPoll = redactUrl(body);
          save();
          return { job, report };
        }
        if (FAILED.has(status)) {
          job.error = String(body.error ?? body.message ?? body.reason ?? `job ${status}`);
          save();
          return { job, report: null };
        }
      }
    } else {
      job.error = `poll failed: ${res instanceof Error ? res.message : String(res)}`;
    }
    save();
    if (d.now() + interval > deadline) {
      job.error = `${job.error ? `${job.error}; ` : ""}still ${job.status} after ${Math.round((opts.timeoutMs ?? RESEARCH_TIMEOUT_MS) / 1000)}s. Resume with gap research --resume ${job.id}`;
      save();
      return { job, report: null };
    }
    await d.sleep(interval);
  }
}

/** Signed download URLs carry credentials in the query string; keep only the path in the saved job. */
const redactUrl = (body: Record<string, unknown>) => {
  const out: Record<string, unknown> = { ...body };
  for (const k of ["downloadUrl", "download_url", "reportUrl", "url"]) {
    if (typeof out[k] === "string") {
      try {
        const u = new URL(out[k] as string, STOCK_AGENT_URL);
        out[k] = `${u.origin}${u.pathname}`;
      } catch {
        out[k] = "redacted";
      }
    }
  }
  return out;
};

async function download(d: PollDeps, url: string, token: string): Promise<string | null> {
  const u = new URL(url, STOCK_AGENT_URL);
  const sameOrigin = u.origin === new URL(STOCK_AGENT_URL).origin;
  const res = await d.fetch(u.toString(), sameOrigin ? { headers: { "X-Job-Token": token } } : {});
  if (!res.ok) throw new Error(`Report download answered HTTP ${res.status} (${basename(u.pathname)}).`);
  return res.text();
}

const clean = (s: string) => s.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
const RATING = /\b(strong buy|strong sell|outperform|underperform|overweight|underweight|accumulate|buy|hold|sell|neutral)\b/i;

/** Lenient extraction of rating, target price, upside and the first risks. The report stays the source of truth. */
export function summarizeReport(md: string): ResearchSummary {
  const lines = md.split(/\r?\n/);
  let rating: string | null = null;
  for (const l of lines) {
    if (/rating|recommendation|verdict|stance/i.test(l)) {
      const m = clean(l).replace(/^[^:|]*(rating|recommendation|verdict|stance)[^:|]*[:|]/i, "").match(RATING);
      if (m) {
        rating = m[1]!.replace(/\b\w/g, (c) => c.toUpperCase());
        break;
      }
    }
  }
  let targetPriceUsd: number | null = null;
  for (const l of lines) {
    const m = /target\s*price[^\n$\d]*\$?\s*([\d,]+(?:\.\d+)?)/i.exec(clean(l));
    if (m) {
      const v = Number(m[1]!.replace(/,/g, ""));
      if (v > 0) {
        targetPriceUsd = v;
        break;
      }
    }
  }
  let upsidePct: number | null = null;
  for (const l of lines) {
    const m = /(upside|downside)[^\n%]*?([+-−]?\d+(?:\.\d+)?)\s?%/i.exec(clean(l));
    if (m) {
      const v = Number(m[2]!.replace("−", "-"));
      upsidePct = m[1]!.toLowerCase() === "downside" && v > 0 ? -v : v;
      break;
    }
  }
  const risks: string[] = [];
  const start = lines.findIndex((l) => /^#{1,6}\s.*risk/i.test(l) || /^\*\*.*risk.*\*\*\s*$/i.test(l.trim()));
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (/^#{1,6}\s/.test(l) && risks.length) break;
      const b = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
      const item = b ? clean(b[1] ?? "") : "";
      if (item) risks.push(item.slice(0, 200));
      else if (/^\|/.test(l) && !/^\|\s*-/.test(l)) {
        const cells = l.split("|").map(clean).filter(Boolean);
        if (cells.length && !/risk|factor|level|impact/i.test(cells[0] ?? "")) risks.push(cells.join(" - ").slice(0, 200));
      }
      if (risks.length >= 3) break;
    }
  }
  return { rating, targetPriceUsd, upsidePct, risks };
}

/** A job file in `dir` by its file name, its file id, or the server's jobId. */
export function findResearchJob(dir: string, ref: string): string {
  if (!existsSync(dir)) throw new Error(`No research job ${ref} in ${dir}.`);
  const files = readdirSync(dir).filter((x) => x.endsWith(".json"));
  const byName = files.find((f) => f === ref || f === `${ref}.json`);
  if (byName) return join(dir, byName);
  for (const f of files) {
    const p = join(dir, f);
    if (readResearchJob(p).jobId === ref) return p;
  }
  throw new Error(`No research job ${ref} in ${dir}.`);
}
