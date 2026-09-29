"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl space-y-4 py-12 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">This page failed to load</h1>
      <p className="text-muted">
        Nothing was traded: the public site only reads data. It is usually a temporary problem reaching the Binance APIs.
        {error.digest && <span className="block font-mono text-xs">ref {error.digest}</span>}
      </p>
      <div className="flex justify-center gap-3 text-sm">
        <button onClick={() => retry()} className="rounded-md border border-line px-3 py-1.5 hover:bg-line">
          Try again
        </button>
        <Link href="/" className="rounded-md border border-line px-3 py-1.5 hover:bg-line">
          Back to the radar
        </Link>
      </div>
    </div>
  );
}
