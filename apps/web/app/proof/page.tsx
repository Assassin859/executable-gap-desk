import type { Metadata } from "next";
import { VerdictChip } from "@/components/VerdictChip";
import { loadReceipts, REPO_URL } from "@/lib/content";
import { pct, shortHash, usd, utc } from "@/lib/format";
import { buildLedger } from "@/lib/proof";

export const metadata: Metadata = { title: "Proof ledger · Executable Gap Desk" };
export const dynamic = "force-static";

const WALLET = "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65";

export default function ProofPage() {
  const ledger = buildLedger(loadReceipts());
  const fills = ledger.onChain.filter((r) => r.outcome === "FILLED" && r.kind === "trade");

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Proof ledger</h1>
        <p className="max-w-3xl text-muted">
          Real BSC mainnet transactions placed by <span className="font-mono">gap exec</span> through the Binance Agentic Wallet{" "}
          <a className="font-mono text-accent underline" href={`https://bscscan.com/address/${WALLET}`}>
            {shortHash(WALLET)}
          </a>
          . Every trade passed the gate (GO), was simulated, and used an exact-amount approval. Refusals stop before anything is signed. Each row is a committed JSON receipt in{" "}
          <a className="underline" href={`${REPO_URL}/tree/main/receipts/exec`}>
            receipts/exec
          </a>
          .
        </p>
      </section>

      {fills.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2">
          {fills.map((f) => (
            <div key={f.id} className="rounded-lg border border-go/40 bg-panel p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-lg font-semibold">{f.what}</span>
                <VerdictChip verdict="GO" />
              </div>
              <p className="num mt-2 text-2xl font-semibold">{usd(f.filledPerShare)}<span className="text-sm font-normal text-muted"> per share filled</span></p>
              <p className="num text-sm text-muted">
                quoted {usd(f.quotedPerShare)} · {pct(f.realizedVsQuotedPct)} vs quote · {pct(f.realizedGapPct)} vs the stock · {usd(f.usd)} spent
              </p>
              {f.txs.map((t) => (
                <a key={t.hash} href={t.url} className="mt-1 block font-mono text-xs text-accent underline">
                  {t.label} {shortHash(t.hash)}
                </a>
              ))}
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">On-chain transactions</h2>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2">Run</th>
                <th className="px-3 py-2">What</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Outcome</th>
                <th className="px-3 py-2">Quoted / filled</th>
                <th className="px-3 py-2">Transactions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ledger.onChain.map((r) => (
                <tr key={r.id}>
                  <td className="num whitespace-nowrap px-3 py-2 text-muted">{utc(r.createdAt)}</td>
                  <td className="px-3 py-2 font-mono">{r.what}</td>
                  <td className="num px-3 py-2">{usd(r.usd)}</td>
                  <td className="px-3 py-2">
                    <span className={r.outcome === "FILLED" ? "text-go" : "text-caution"}>{r.outcome}</span>
                    {r.refusal && <div className="text-xs text-muted">{r.refusal.code}: approval confirmed, swap refused before signing</div>}
                  </td>
                  <td className="num px-3 py-2">
                    {r.filledPerShare !== null ? (
                      <>
                        {usd(r.quotedPerShare)} / <span className="font-semibold">{usd(r.filledPerShare)}</span>
                      </>
                    ) : r.tokensOut !== null ? (
                      `${r.tokensOut.toFixed(4)} USDT received`
                    ) : (
                      <span className="text-muted">n/a</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.txs.map((t) => (
                      <a key={t.hash} href={t.url} className="block font-mono text-xs text-accent underline">
                        {t.label} {shortHash(t.hash)}
                      </a>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Refused before signing</h2>
        <p className="text-sm text-muted">The gate or the simulation stopped these; nothing was broadcast. {ledger.dryRuns} further dry runs simulated without signing.</p>
        <ul className="space-y-2">
          {ledger.refusals.map((r) => (
            <li key={r.id} className="rounded-lg border border-line bg-panel p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold">{r.what}</span>
                <span className="num text-muted">{usd(r.usd)}</span>
                <span className="text-muted">
                  {r.mode} · {utc(r.createdAt)}
                </span>
                {r.verdict && <VerdictChip verdict={r.verdict} small />}
                <span className="font-mono text-xs text-block">{r.refusal?.code}</span>
              </div>
              <p className="mt-1 text-muted">{r.refusal?.message}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
