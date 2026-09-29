import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listReceipts, type ExecReceipt } from "@gapdesk/core";
import { parseDxLog, type DxEntry } from "./dx";
import { REPO_ROOT } from "./server";

/** Read at build time: the proof and DX pages are static snapshots of what is committed. */
export function loadReceipts(): ExecReceipt[] {
  const dir = resolve(REPO_ROOT, "receipts", "exec");
  return existsSync(/*turbopackIgnore: true*/ dir) ? listReceipts(dir) : [];
}

export function loadDxLog(): DxEntry[] {
  const file = resolve(REPO_ROOT, "docs", "DX_LOG.md");
  return existsSync(/*turbopackIgnore: true*/ file) ? parseDxLog(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) : [];
}

export const REPO_URL = "https://github.com/Assassin859/executable-gap-desk";
