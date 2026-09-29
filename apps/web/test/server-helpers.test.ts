import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExecReceipt } from "@gapdesk/core";
import { createThrottle, createTtlCache } from "../lib/cache";
import { codeSpans, githubSlug, parseDxLog } from "../lib/dx";
import { execGuard, parseExecRequest } from "../lib/execGuard";
import { buildLedger } from "../lib/proof";

const root = resolve(import.meta.dirname, "../../..");

describe("execGuard", () => {
  const local = { host: "localhost:3000", forwardedFor: null };

  it("hides the endpoint unless EXECUTE_MODE=local, and always on Vercel", () => {
    expect(execGuard({}, local)).toMatchObject({ ok: false, status: 404 });
    expect(execGuard({ EXECUTE_MODE: "remote" }, local)).toMatchObject({ ok: false, status: 404 });
    expect(execGuard({ EXECUTE_MODE: "local", VERCEL: "1" }, local)).toMatchObject({ ok: false, status: 404 });
    expect(execGuard({ EXECUTE_MODE: "local" }, local)).toEqual({ ok: true });
    expect(execGuard({ EXECUTE_MODE: "local" }, { host: "127.0.0.1:3100", forwardedFor: "127.0.0.1" })).toEqual({ ok: true });
  });

  it("refuses requests not addressed to or coming from this machine", () => {
    expect(execGuard({ EXECUTE_MODE: "local" }, { host: "desk.vercel.app", forwardedFor: null })).toMatchObject({ ok: false, status: 403 });
    expect(execGuard({ EXECUTE_MODE: "local" }, { host: null, forwardedFor: null })).toMatchObject({ ok: false, status: 403 });
    expect(execGuard({ EXECUTE_MODE: "local" }, { host: "localhost.evil.com", forwardedFor: null })).toMatchObject({ ok: false, status: 403 });
    expect(execGuard({ EXECUTE_MODE: "local" }, { host: "localhost:3000", forwardedFor: "8.8.8.8" })).toMatchObject({ ok: false, status: 403 });
  });

  it("validates the request and needs a typed yes for live", () => {
    expect(parseExecRequest({ symbol: "NVDAB", usd: 1.5 }, 25)).toEqual({ ok: true, req: { symbol: "NVDAB", usd: 1.5, live: false } });
    expect(parseExecRequest({ symbol: "NVDAB", usd: 1.5, live: true }, 25)).toMatchObject({ ok: false });
    expect(parseExecRequest({ symbol: "NVDAB", usd: 1.5, live: true, confirm: "yes" }, 25)).toEqual({ ok: true, req: { symbol: "NVDAB", usd: 1.5, live: true } });
    expect(parseExecRequest({ symbol: "NVDAB", usd: 26 }, 25)).toMatchObject({ ok: false });
    expect(parseExecRequest({ symbol: "NVDAB; rm -rf", usd: 1 }, 25)).toMatchObject({ ok: false });
    expect(parseExecRequest(null, 25)).toMatchObject({ ok: false });
  });
});

describe("cache and throttle", () => {
  it("shares in-flight loads, expires after the TTL and does not cache failures", async () => {
    let t = 0;
    const cache = createTtlCache<number>(1000, () => t);
    const load = vi.fn(async () => 1);
    await Promise.all([cache.get("a", load), cache.get("a", load)]);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1500;
    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(2);
    await expect(cache.get("b", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(cache.has("b")).toBe(false);
  });

  it("limits calls per key in a sliding window", () => {
    let t = 0;
    const th = createThrottle(2, 1000, () => t);
    expect([th.allow("ip"), th.allow("ip"), th.allow("ip"), th.allow("other")]).toEqual([true, true, false, true]);
    t = 1001;
    expect(th.allow("ip")).toBe(true);
  });
});

describe("DX log parser", () => {
  const entries = parseDxLog(readFileSync(resolve(root, "docs/DX_LOG.md"), "utf8"));

  it("reads every summary row with its heading anchor", () => {
    expect(entries.length).toBeGreaterThanOrEqual(28);
    expect(entries.map((e) => e.n)).toEqual(entries.map((_, i) => i + 1));
    expect(entries.every((e) => e.slug && ["High", "Medium", "Low"].includes(e.severity))).toBe(true);
    expect(entries.find((e) => e.n === 16)?.slug).toBe("16-docs-say-ondo-always-routes-via-rfq-live-quotes-are-all-swap");
  });

  it("slugs like GitHub and splits code spans", () => {
    expect(githubSlug("25. A Lifi fill landed 0.50% below its quote and simulation")).toBe("25-a-lifi-fill-landed-050-below-its-quote-and-simulation");
    expect(codeSpans("`/swap` suggests `gas`")).toEqual([
      { text: "/swap", code: true },
      { text: " suggests ", code: false },
      { text: "gas", code: true },
    ]);
  });
});

describe("proof ledger", () => {
  const dir = resolve(root, "receipts/exec");
  const receipts = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as ExecReceipt);
  const ledger = buildLedger(receipts);

  it("lists the mainnet fills with quote vs fill and BscScan links", () => {
    const fills = ledger.onChain.filter((r) => r.outcome === "FILLED" && r.kind === "trade");
    expect(fills.map((f) => f.what)).toEqual(expect.arrayContaining(["NVDAB", "AAPLB"]));
    for (const f of fills) {
      expect(f.filledPerShare).toBeGreaterThan(0);
      expect(f.quotedPerShare).toBeGreaterThan(0);
      expect(f.txs.every((t) => t.url === `https://bscscan.com/tx/${t.hash}`)).toBe(true);
    }
  });

  it("keeps refusals separate and in time order", () => {
    expect(ledger.refusals.length).toBeGreaterThan(0);
    expect(ledger.refusals.every((r) => r.outcome === "REFUSED" && r.txs.length === 0)).toBe(true);
    expect(ledger.refusals.map((r) => r.what)).toEqual(expect.arrayContaining(["MSTRx", "AAOIB"]));
    const times = ledger.onChain.map((r) => r.createdAt);
    expect(times).toEqual([...times].sort());
  });
});
