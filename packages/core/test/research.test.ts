import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findResearchJob, pollResearch, readResearchJob, submitResearch, summarizeReport, type ResearchJob, type X402Deps, type X402Preview } from "../src/index";
import { fixture } from "./helpers";

const W = "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65";
const env = { GAP_WALLET_ADDRESS: W } as NodeJS.ProcessEnv;
const NOW = Date.parse("2026-09-29T18:00:00Z");
const rec = fixture<{ required: { header: string; body: unknown }; preview: X402Preview }>("x402.json");
const preview: X402Preview = { ...rec.preview, options: rec.preview.options.map((o) => (o.tokenSymbol === "U" ? { ...o, status: "READY_TO_SIGN", reasons: [] } : o)) };

const REPORT = `# NVDA Comprehensive Analysis

## Summary
**Rating:** Buy
**Target Price:** $265.00 (Upside: +15.4%)

## Key Risks
- Export controls on data-center GPUs to China
- Customer concentration in hyperscalers
- Valuation leaves little room for a miss
- Supply constraints at TSMC

## Technicals
RSI 58.
`;

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "gap-research-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const r402 = () => new Response(JSON.stringify(rec.required.body), { status: 402, headers: { "payment-required": rec.required.header } });

function x402Deps(responses: Response[]) {
  const queue = [...responses];
  return {
    fetch: vi.fn(async () => queue.shift() ?? json({ error: "no more" }, 500)) as unknown as typeof fetch,
    wallet: { x402Preview: vi.fn(async () => preview), x402Sign: vi.fn(async () => ({ paymentHeaderName: "PAYMENT-SIGNATURE", paymentHeaderValue: "sig", signatureExpiresAt: null, approveTxHash: null })) },
    confirm: vi.fn(async () => true),
    now: () => NOW,
    log: () => {},
  } satisfies X402Deps;
}

const settled = Buffer.from(JSON.stringify({ success: true, transaction: `0x${"12".repeat(32)}` })).toString("base64");

describe("submitResearch", () => {
  it("dry run previews the payment and writes no job", async () => {
    const dir = tmp();
    const d = x402Deps([r402()]);
    const r = await submitResearch(["nvda"], { env, deps: d, researchDir: dir, x402Dir: null, prior: [] });
    expect(r.receipt?.outcome).toBe("SIMULATED");
    expect(r.job).toBeNull();
    expect(d.wallet.x402Sign).not.toHaveBeenCalled();
  });

  it("saves jobId and jobToken to disk the moment the paid job is accepted, before any polling", async () => {
    const dir = tmp();
    const d = x402Deps([r402(), json({ jobId: "job-1", jobToken: "tok-secret" }, 202, { "payment-response": settled })]);
    const r = await submitResearch(["NVDA"], { live: true, env, deps: d, researchDir: dir, x402Dir: null, prior: [] });
    expect(d.fetch).toHaveBeenCalledTimes(2);
    expect(existsSync(r.jobPath!)).toBe(true);
    const saved = readResearchJob(r.jobPath!);
    expect(saved).toMatchObject({ jobId: "job-1", jobToken: "tok-secret", status: "submitted", symbols: ["NVDA"], paid: { token: "U", settlementTx: `0x${"12".repeat(32)}` } });
    expect(saved.x402ReceiptId).toBe(r.receipt!.id);
    expect(JSON.parse(vi.mocked(d.fetch).mock.calls[0]![1]!.body as string)).toEqual({ symbols: ["NVDA"], analysis_type: "comprehensive" });
    expect(findResearchJob(dir, "job-1")).toBe(r.jobPath);
    expect(findResearchJob(dir, r.job!.id)).toBe(r.jobPath);
    expect(() => findResearchJob(dir, "nope")).toThrow(/No research job/);
  });

  it("keeps an unreadable paid response verbatim instead of losing it", async () => {
    const dir = tmp();
    const d = x402Deps([r402(), new Response("accepted, id 42", { status: 202 })]);
    const r = await submitResearch(["NVDA"], { live: true, env, deps: d, researchDir: dir, x402Dir: null, prior: [] });
    expect(readResearchJob(r.jobPath!)).toMatchObject({ status: "unparsed", jobId: null, submitRaw: "accepted, id 42" });
  });

  it("rejects bad tickers before paying", async () => {
    await expect(submitResearch(["NVDA; rm"], { env, deps: x402Deps([]), researchDir: null, x402Dir: null })).rejects.toThrow(/tickers/);
  });
});

const job = (): ResearchJob => ({
  version: 1,
  id: "2026-09-29T18-00-00-000Z-research-NVDA",
  createdAt: new Date(NOW).toISOString(),
  symbols: ["NVDA"],
  analysisType: "comprehensive",
  jobId: "job-1",
  jobToken: "tok-secret",
  x402ReceiptId: "r1",
  paid: null,
  status: "submitted",
  polls: 0,
  lastPolledAt: null,
  error: null,
  reportFile: null,
  summary: null,
});

function pollDeps(responses: Response[]) {
  let clock = NOW;
  const queue = [...responses];
  return {
    fetch: vi.fn(async () => queue.shift() ?? json({ status: "running" })) as unknown as typeof fetch,
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    log: () => {},
  };
}

describe("pollResearch", () => {
  it("polls through queued and running, saves the report, summarizes it and hashes the token", async () => {
    const dir = tmp();
    const d = pollDeps([json({ status: "queued" }), json({ status: "running" }), json({ status: "succeeded", downloadUrl: "/x402/jobs/job-1/report?sig=abc" }), new Response(REPORT)]);
    const { job: done, report } = await pollResearch(job(), { researchDir: dir, deps: d });
    expect(report).toBe(REPORT);
    const calls = vi.mocked(d.fetch).mock.calls;
    expect(calls[0]![0]).toBe("https://stock-agent.bnbchain.org/x402/jobs/job-1");
    expect(calls[0]![1]).toMatchObject({ headers: { "X-Job-Token": "tok-secret" } });
    expect(calls[3]![0]).toBe("https://stock-agent.bnbchain.org/x402/jobs/job-1/report?sig=abc");
    expect(calls[3]![1]).toMatchObject({ headers: { "X-Job-Token": "tok-secret" } });
    const saved = readResearchJob(join(dir, `${done.id}.json`));
    expect(saved).toMatchObject({ status: "succeeded", polls: 3, reportFile: `${done.id}.md`, summary: { rating: "Buy", targetPriceUsd: 265, upsidePct: 15.4 } });
    expect(saved.jobToken).toBeUndefined();
    expect(saved.jobTokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(saved)).not.toContain("tok-secret");
    expect(JSON.stringify(saved)).not.toContain("sig=abc");
    expect(readFileSync(join(dir, saved.reportFile!), "utf8")).toBe(REPORT);
  });

  it("does not send the job token to a download on another origin", async () => {
    const d = pollDeps([json({ status: "succeeded", downloadUrl: "https://reports.s3.amazonaws.com/nvda.md?X-Amz-Signature=x" }), new Response(REPORT)]);
    await pollResearch(job(), { researchDir: null, deps: d });
    expect(vi.mocked(d.fetch).mock.calls[1]![1]).toEqual({});
  });

  it("records a failed job", async () => {
    const d = pollDeps([json({ status: "failed", error: "symbol not covered" })]);
    const { job: j, report } = await pollResearch(job(), { researchDir: null, deps: d });
    expect(report).toBeNull();
    expect(j).toMatchObject({ status: "failed", error: "symbol not covered", jobToken: "tok-secret" });
  });

  it("times out resumable: the token is kept and nothing is re-submitted", async () => {
    const dir = tmp();
    const d = pollDeps([json({ error: "busy" }, 503)]);
    const { job: j } = await pollResearch(job(), { researchDir: dir, deps: d, intervalMs: 15_000, timeoutMs: 60_000 });
    expect(j.jobToken).toBe("tok-secret");
    expect(j.error).toMatch(/Resume with gap research --resume/);
    expect(vi.mocked(d.fetch).mock.calls.every((c) => String(c[0]).includes("/x402/jobs/"))).toBe(true);
    expect(readResearchJob(join(dir, `${j.id}.json`)).jobToken).toBe("tok-secret");
  });
});

describe("summarizeReport", () => {
  it("reads rating, target, upside and the first three risks", () => {
    expect(summarizeReport(REPORT)).toEqual({
      rating: "Buy",
      targetPriceUsd: 265,
      upsidePct: 15.4,
      risks: ["Export controls on data-center GPUs to China", "Customer concentration in hyperscalers", "Valuation leaves little room for a miss"],
    });
  });

  it("returns nulls when the report says nothing it can read", () => {
    expect(summarizeReport("Just some text.")).toEqual({ rating: null, targetPriceUsd: null, upsidePct: null, risks: [] });
  });

  it("handles a downside and a risk table", () => {
    const md = "| Recommendation | Strong Sell |\n\nTarget price: 90 USD, downside 12%\n\n## Risk Panel\n| Risk | Level |\n|---|---|\n| Margin compression | High |\n";
    expect(summarizeReport(md)).toMatchObject({ rating: "Strong Sell", targetPriceUsd: 90, upsidePct: -12, risks: ["Margin compression - High"] });
  });
});
