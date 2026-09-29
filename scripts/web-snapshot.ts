/**
 * Writes the slim snapshot the web desk's Radar serves (apps/web/data/snapshot.json).
 *
 *   pnpm web:snapshot                 fresh $25 sweep of every BSC tokenized stock (~75 s, needs .env.local)
 *   pnpm web:snapshot --from <file>   slim an existing `gap snapshot --all --out <file>` JSON instead
 *
 * Run the fresh sweep during the US regular session, then commit the file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot, toPublicSnapshot, type Snapshot } from "../packages/core/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "apps/web/data/snapshot.json");
const fromIdx = process.argv.indexOf("--from");
const from = fromIdx > 0 ? process.argv[fromIdx + 1] : undefined;

let snap: Snapshot;
if (from) {
  snap = JSON.parse(readFileSync(resolve(from), "utf8")) as Snapshot;
} else {
  const envFile = resolve(root, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  snap = await buildSnapshot({
    scope: "all",
    usd: 25,
    onProgress: (done, total) => {
      if (done === total || done % 50 === 0) process.stderr.write(`quoting ${done}/${total}\n`);
    },
  });
}

const pub = toPublicSnapshot(snap);
mkdirSync(dirname(out), { recursive: true });
const json = `${JSON.stringify(pub)}\n`;
writeFileSync(out, json);
const s = pub.summary;
console.log(
  `wrote ${out} (${(json.length / 1024).toFixed(0)} KB): ${s.tickers} tickers, ${s.venues} venues, ${s.go} GO / ${s.caution} CAUTION / ${s.block} BLOCK, ` +
    `session ${pub.session?.session ?? "unknown"}, built ${new Date(pub.builtAt).toISOString()}`,
);
