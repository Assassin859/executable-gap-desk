import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listReceipts, listX402Receipts, type ExecReceipt, type X402Receipt } from "@gapdesk/core";
import { parseDxLog, type DxEntry } from "./dx";
import type { B402SelftestRecord, IdentityRecord, OnchainAnnotations, SaleRecord } from "./proof";
import { REPO_ROOT } from "./server";

/** Read at build time: the proof and DX pages are static snapshots of what is committed. */
export function loadReceipts(): ExecReceipt[] {
  const dir = resolve(REPO_ROOT, "receipts", "exec");
  return existsSync(/*turbopackIgnore: true*/ dir) ? listReceipts(dir) : [];
}

export function loadX402Receipts(): X402Receipt[] {
  return listX402Receipts(resolve(REPO_ROOT, "receipts", "x402"));
}

function readJson<T>(file: string): T | null {
  return existsSync(/*turbopackIgnore: true*/ file) ? (JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as T) : null;
}

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(/*turbopackIgnore: true*/ dir)) return [];
  return readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(/*turbopackIgnore: true*/ resolve(dir, f), "utf8")) as T);
}

export function loadSales(): SaleRecord[] {
  return readJsonDir<SaleRecord>(resolve(REPO_ROOT, "receipts", "x402-sales"));
}

export function loadOnchainAnnotations(): OnchainAnnotations {
  return readJson<OnchainAnnotations>(resolve(REPO_ROOT, "receipts", "x402-onchain.json")) ?? {};
}

export function loadIdentity(): IdentityRecord | null {
  return readJson<IdentityRecord>(resolve(REPO_ROOT, "receipts", "identity.json"));
}

/** The latest live B402 self-test (dry runs are skipped). */
export function loadB402Selftest(): B402SelftestRecord | null {
  const live = readJsonDir<B402SelftestRecord>(resolve(REPO_ROOT, "receipts", "b402")).filter((r) => r.mode === "live");
  return live.at(-1) ?? null;
}

export function loadDxLog(): DxEntry[] {
  const file = resolve(REPO_ROOT, "docs", "DX_LOG.md");
  return existsSync(/*turbopackIgnore: true*/ file) ? parseDxLog(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) : [];
}

export const REPO_URL = "https://github.com/Assassin859/executable-gap-desk";
