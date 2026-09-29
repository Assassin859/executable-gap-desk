import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Executable Gap Desk",
  description: "Displayed gaps lie. Executable ones don't. Tokenized US stocks on BNB Smart Chain (Ondo, xStocks, bStocks), gated GO / CAUTION / BLOCK.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0f14" };

const NAV = [
  { href: "/", label: "Radar" },
  { href: "/proof", label: "Proof" },
  { href: "/dx", label: "DX log" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <header className="border-b border-line bg-panel/60 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="text-lg font-semibold tracking-tight">Executable Gap Desk</span>
              <span className="hidden text-sm text-muted sm:inline">Displayed gaps lie. Executable ones don&apos;t.</span>
            </Link>
            <nav className="flex gap-1 text-sm">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-muted hover:bg-line hover:text-white">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-xs text-muted">
          BNB Hack: Tokenized Stocks Edition. BSC mainnet, spot only. Quotes from the Binance Web3 aggregator; not investment advice.{" "}
          <a className="underline hover:text-white" href="https://github.com/Assassin859/executable-gap-desk">
            Source
          </a>
        </footer>
      </body>
    </html>
  );
}
