import type { Metadata } from "next";
import { VerdictChip } from "@/components/VerdictChip";
import { loadB402Selftest, loadIdentity, loadOnchainAnnotations, loadReceipts, loadSales, loadX402Receipts, REPO_URL } from "@/lib/content";
import { pct, shortHash, usd, utc } from "@/lib/format";
import { buildLedger, buildX402Ledger, identityRow, selftestRow } from "@/lib/proof";

export const metadata: Metadata = { title: "Proof ledger · Executable Gap Desk" };
export const dynamic = "force-static";

const WALLET = "0x623dF829DF5cf33506a0fbb152dbc885d5b61C65";
const DX = `${REPO_URL}/blob/main/docs/DX_LOG.md`;
const DX_ANCHOR: Record<number, string> = {
  37: "37-the-bnb-stock-agent-rejects-valid-agentic-wallet-u-payments-with-a-bare-payment_rejected",
  38: "38-payment-response-has-a-different-shape-per-seller-coinmarketcaps-carries-no-transaction-hash",
  41: "41-wallet-send-only-reaches-address-book-recipients-help-doesnt-say-so-and-no-cli-command-can-add-one",
};

function DxLink({ n }: { n: keyof typeof DX_ANCHOR }) {
  return (
    <a className="underline" href={`${DX}#${DX_ANCHOR[n]}`}>
      DX #{n}
    </a>
  );
}

function TxLink({ tx }: { tx: { label: string; hash: string; url: string } }) {
  return (
    <a href={tx.url} className="block font-mono text-xs text-accent underline">
      {tx.label} {shortHash(tx.hash)}
    </a>
  );
}

export default function ProofPage() {
  const ledger = buildLedger(loadReceipts());
  const fills = ledger.onChain.filter((r) => r.outcome === "FILLED" && r.kind === "trade");
  const x402 = buildX402Ledger(loadX402Receipts(), loadSales(), loadOnchainAnnotations());
  const identity = identityRow(loadIdentity());
  const selftest = selftestRow(loadB402Selftest());
  const sells = fills.filter((f) => f.side === "sell").length;
  const paidPurchases = x402.purchases.filter((p) => p.outcome === "PAID");
  const summary: { href: string; value: string; label: string }[] = [
    { href: "#fills", value: String(fills.length), label: `gated fills (${fills.length - sells} buys, ${sells} sells)` },
    { href: "#onchain", value: String(ledger.onChain.reduce((n, r) => n + r.txs.length, 0)), label: `on-chain transactions in ${ledger.onChain.length} runs` },
    { href: "#refusals", value: String(ledger.refusals.length), label: "refused before signing" },
    { href: "#selling", value: String(x402.sales.length), label: "x402 sale settled by B402" },
    { href: "#buying", value: String(paidPurchases.length), label: "x402 data purchase paid" },
    ...(identity ? [{ href: "#identity", value: `#${identity.agentId}`, label: "ERC-8004 agent" }] : []),
  ];

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Proof ledger</h1>
        <p className="max-w-3xl text-muted">
          Real BSC mainnet activity of the Binance Agentic Wallet{" "}
          <a className="font-mono text-accent underline" href={`https://bscscan.com/address/${WALLET}`}>
            {shortHash(WALLET)}
          </a>
          : gated trades from <span className="font-mono">gap exec</span>, x402 payments it made and received, and its ERC-8004 registration. Every trade, buy or sell, passed the
          gate (GO). Contract calls were simulated with an exact-amount approval; wallet market orders had to match the gated quote within 0.5%. Refusals stop before anything
          is signed. Each row is a committed JSON receipt in{" "}
          <a className="underline" href={`${REPO_URL}/tree/main/receipts`}>
            receipts/
          </a>
          .
        </p>
        <nav aria-label="Proof sections" className="grid grid-cols-2 gap-2 pt-2 sm:grid-cols-3 lg:grid-cols-6">
          {summary.map((s) => (
            <a key={s.href} href={s.href} className="rounded-lg border border-line bg-panel px-3 py-2 transition hover:border-accent">
              <div className="num text-xl font-semibold">{s.value}</div>
              <div className="text-xs text-muted">{s.label}</div>
            </a>
          ))}
        </nav>
      </section>

      {fills.length > 0 && (
        <section id="fills" className="grid scroll-mt-4 gap-3 sm:grid-cols-2">
          {fills.map((f) => (
            <div key={f.id} className="rounded-lg border border-go/40 bg-panel p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-lg font-semibold">{f.what}</span>
                <VerdictChip verdict="GO" />
              </div>
              <p className="num mt-2 text-2xl font-semibold">
                {usd(f.filledPerShare)}
                <span className="text-sm font-normal text-muted"> per share {f.side === "sell" ? "received" : "filled"}</span>
              </p>
              <p className="num text-sm text-muted">
                quoted {usd(f.quotedPerShare)} · {pct(f.realizedVsQuotedPct)} vs quote · {pct(f.realizedGapPct)} vs the stock · {usd(f.usd)} {f.side === "sell" ? "received" : "spent"}
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

      <section id="onchain" className="scroll-mt-4 space-y-2">
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

      {ledger.limits.length > 0 && (
        <details id="limits" className="group scroll-mt-4 space-y-2">
          <summary className="cursor-pointer list-none font-semibold">
            <span className="mr-1 inline-block text-muted transition group-open:rotate-90">›</span>
            Limit orders <span className="text-sm font-normal text-muted">({ledger.limits.length}, nothing on chain unless one triggers)</span>
          </summary>
          <p className="mt-2 text-sm text-muted">
            Gap-guarded limit buys through the Agentic Wallet: only on a GO venue, with the trigger under the stock and under the market. Nothing is on chain unless one triggers.
          </p>
          <ul className="mt-2 space-y-2">
            {ledger.limits.map((r) => (
              <li key={r.id} className="rounded-lg border border-line bg-panel p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{r.what}</span>
                  <span className="num text-muted">{usd(r.usd)}</span>
                  {r.triggerPriceUsd !== null && <span className="num text-muted">trigger ${r.triggerPriceUsd.toFixed(4)}/token</span>}
                  <span className={r.outcome === "PLACED" ? "text-go" : r.outcome === "CANCELED" ? "text-accent" : "text-block"}>
                    {r.orderId ? r.outcome : "NOT PLACED"}
                  </span>
                  {r.orderId && <span className="font-mono text-xs text-muted">strategy {r.orderId}</span>}
                  <span className="text-muted">{utc(r.createdAt)}</span>
                  {r.verdict && <VerdictChip verdict={r.verdict} small />}
                </div>
                {!r.orderId && r.refusal && <p className="mt-1 text-muted">The Agentic Wallet turned it down: {r.refusal.message}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <section id="refusals" className="scroll-mt-4 space-y-2">
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

      {(x402.sales.length > 0 || selftest) && (
        <section id="selling" className="scroll-mt-4 space-y-2">
          <h2 className="font-semibold">Selling over x402 (B402)</h2>
          <p className="text-sm text-muted">
            The desk&apos;s paid endpoints settle through Binance&apos;s B402 facilitator into the Agentic Wallet. B402 submits the U transfer and pays its gas.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {x402.sales.map((s) => (
              <div key={s.tx.hash} className="rounded-lg border border-go/40 bg-panel p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono font-semibold">GET {new URL(s.endpoint).pathname}</span>
                  <span className="text-go">PAID · HTTP {s.httpStatus}</span>
                </div>
                <p className="num mt-2 text-2xl font-semibold">
                  {s.priceU} U<span className="text-sm font-normal text-muted"> settled {utc(s.settledAt)}</span>
                </p>
                <p className="num text-muted">
                  block {s.block} · {Number(s.gasUsed).toLocaleString("en-US")} gas at {s.gasPriceGwei} gwei, paid by B402 {shortHash(s.submittedBy)}
                </p>
                {!s.independent && (
                  <div className="mt-3 space-y-1 rounded-md border border-line p-3">
                    <p>
                      <span className="font-semibold text-go">Proves:</span> the deployed endpoint answered 402, then ran B402 Verify, the gate and B402 Settle, and B402 put the
                      transfer on BSC mainnet.
                    </p>
                    <p>
                      <span className="font-semibold text-caution">Doesn&apos;t prove:</span> an outside buyer. The buyer was the Agentic Wallet itself ({shortHash(s.buyer)}), so
                      no value changed hands; the wallet only sends to address-book entries, so we couldn&apos;t fund a separate buyer (<DxLink n={41} />).
                    </p>
                    {paidPurchases.length > 0 && (
                      <p className="text-muted">
                        Paying a third party is shown on the buying side: <a className="underline" href="#buying">the CoinMarketCap purchase below</a> settled on chain.
                      </p>
                    )}
                  </div>
                )}
                <div className="mt-2">
                  <TxLink tx={s.tx} />
                </div>
              </div>
            ))}
            {selftest && (
              <details className="group self-start rounded-lg border border-line bg-panel p-4 text-sm">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">
                    <span className="mr-1 inline-block text-muted transition group-open:rotate-90">›</span>
                    B402 self-test (verify only)
                  </span>
                  <span className={selftest.isValid ? "text-go" : "text-block"}>{selftest.isValid ? "isValid: true" : `invalid: ${selftest.invalidReason ?? "unknown"}`}</span>
                </summary>
                <p className="mt-2 text-muted">
                  A {selftest.amount} {selftest.token} authorization signed by the Agentic Wallet for {new URL(selftest.resource).pathname}, sent to B402 Verify and never
                  settled, so nothing moved. It proves the onboarded payTo ({shortHash(selftest.payTo)}) is the wallet.
                </p>
                <p className="mt-1 text-muted">{utc(selftest.at)}</p>
              </details>
            )}
          </div>
        </section>
      )}

      {x402.purchases.length > 0 && (
        <section id="buying" className="scroll-mt-4 space-y-2">
          <h2 className="font-semibold">Paying for data over x402</h2>
          <p className="text-sm text-muted">
            Paid calls to other agents through <span className="font-mono">baw x402-payment</span>, capped per call and per day. {x402.dryRuns} further dry runs stopped
            before signing.
          </p>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-panel text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Run</th>
                  <th className="px-3 py-2">Seller</th>
                  <th className="px-3 py-2">Paid with</th>
                  <th className="px-3 py-2">Outcome</th>
                  <th className="px-3 py-2">Settlement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {x402.purchases.map((p) => (
                  <tr key={p.id}>
                    <td className="num whitespace-nowrap px-3 py-2 text-muted">{utc(p.createdAt)}</td>
                    <td className="px-3 py-2">
                      <span className="font-mono">{p.seller}</span>
                      {!p.label.startsWith(p.seller) && <div className="text-xs text-muted">{p.label}</div>}
                    </td>
                    <td className="num px-3 py-2">{p.amount ? `${p.amount} ${p.token}` : "n/a"}</td>
                    <td className="px-3 py-2">
                      <span className={p.outcome === "PAID" ? "text-go" : "text-block"}>{p.outcome === "PAID" ? `PAID · HTTP ${p.httpStatus}` : "REJECTED"}</span>
                      {p.outcome !== "PAID" && (
                        <div className="text-xs text-muted">
                          {p.error ?? "no reason given"}; nothing charged (<DxLink n={37} />)
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {p.tx ? (
                        <>
                          <TxLink tx={p.tx} />
                          {p.txFoundOnchain && (
                            <div className="text-xs text-muted">
                              found in U transfer logs; the seller sent no tx (<DxLink n={38} />)
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-muted">none</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {identity && (
        <section id="identity" className="scroll-mt-4 space-y-2">
          <h2 className="font-semibold">Agent identity (ERC-8004)</h2>
          <div className="rounded-lg border border-line bg-panel p-4 text-sm">
            <p className="text-2xl font-semibold">
              agent <span className="num">{identity.agentId}</span>
              <span className="text-sm font-normal text-muted"> registered {utc(identity.registeredAt)}</span>
            </p>
            <p className="mt-1 text-muted">
              In the IdentityRegistry{" "}
              <a className="font-mono text-accent underline" href={`https://bscscan.com/address/${identity.registry}`}>
                {shortHash(identity.registry)}
              </a>
              , owned by the Agentic Wallet {shortHash(identity.owner)}. Its agentURI is the{" "}
              <a className="underline" href={identity.agentURI}>
                agent card
              </a>
              , which names agent {identity.agentId} back.
            </p>
            <p className="num mt-1 text-muted">
              block {identity.block} · {Number(identity.gasUsed).toLocaleString("en-US")} gas · {identity.gasCostBnb.toFixed(7)} BNB
            </p>
            <div className="mt-2">
              <TxLink tx={identity.tx} />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
