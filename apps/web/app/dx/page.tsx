import type { Metadata } from "next";
import { loadDxLog, REPO_URL } from "@/lib/content";
import { codeSpans } from "@/lib/dx";

export const metadata: Metadata = { title: "DX log · Executable Gap Desk" };
export const dynamic = "force-static";

const SEVERITY_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
const SEVERITY_STYLE: Record<string, string> = {
  High: "bg-block/15 text-block ring-block/40",
  Medium: "bg-caution/15 text-caution ring-caution/40",
  Low: "bg-line text-muted ring-line",
};

function Md({ s }: { s: string }) {
  return (
    <>
      {codeSpans(s).map((p, i) =>
        p.code ? (
          <code key={i} className="rounded bg-ink px-1 font-mono text-[0.85em]">
            {p.text}
          </code>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export default function DxPage() {
  const entries = loadDxLog().sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || a.n - b.n);
  const count = (s: string) => entries.filter((e) => e.severity === s).length;
  const logUrl = `${REPO_URL}/blob/main/docs/DX_LOG.md`;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Developer experience log</h1>
        <p className="max-w-3xl text-muted">
          Every rough edge we hit building on the Binance Web3 APIs, the Skills Hub and the Agentic Wallet CLI, each reproduced by hand with a suggested fix. {entries.length} entries: {count("High")}{" "}
          high, {count("Medium")} medium, {count("Low")} low.{" "}
          <a className="text-accent underline" href={logUrl}>
            Full log with reproductions
          </a>
        </p>
      </section>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.n}>
            <a href={e.slug ? `${logUrl}#${e.slug}` : logUrl} className="flex flex-wrap items-start gap-3 rounded-lg border border-line bg-panel p-3 hover:border-accent">
              <span className="num w-8 shrink-0 font-mono text-muted">#{e.n}</span>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${SEVERITY_STYLE[e.severity] ?? SEVERITY_STYLE.Low}`}>{e.severity}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm">
                  <Md s={e.summary} />
                </span>
                <span className="text-xs text-muted">
                  <Md s={e.area} /> · {e.date}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
