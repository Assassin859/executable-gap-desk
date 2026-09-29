"use client";

import type { PublicSession } from "@gapdesk/core";
import { useEffect, useState } from "react";
import { countdown, SESSION_LABEL } from "@/lib/format";

export function SessionBadge() {
  const [session, setSession] = useState<PublicSession | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/session")
        .then((r) => r.json() as Promise<{ session: PublicSession | null }>)
        .then((d) => alive && setSession(d.session))
        .catch(() => alive && setSession(null));
    load();
    const poll = setInterval(load, 60_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  if (session === undefined) return <span className="text-sm text-muted">Checking the US session…</span>;
  if (session === null) return <span className="text-sm text-muted">US session unavailable</span>;

  const regular = session.session === "regular";
  const next = session.nextEvent;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm">
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ring-1 ring-inset ${regular ? "bg-go/10 text-go ring-go/40" : "bg-caution/10 text-caution ring-caution/40"}`}>
        <span className={`h-2 w-2 rounded-full ${regular ? "bg-go" : "bg-caution"}`} />
        Now: {SESSION_LABEL[session.session]}
      </span>
      {next && (
        <span className="num text-muted">
          {next.type === "open" ? "opens" : "closes"} in {countdown(new Date(next.at).getTime() - now)}
        </span>
      )}
      {!regular && <span className="text-muted">· off-hours: the gate caps every verdict at CAUTION</span>}
    </span>
  );
}
