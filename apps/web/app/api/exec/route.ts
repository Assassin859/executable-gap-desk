import { resolve } from "node:path";
import { DEFAULT_POLICY, executeTrade } from "@gapdesk/core";
import { execGuard, parseExecRequest } from "@/lib/execGuard";
import { loadLocalEnv, REPO_ROOT } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const guard = execGuard({ EXECUTE_MODE: process.env.EXECUTE_MODE, VERCEL: process.env.VERCEL }, { host: req.headers.get("host"), forwardedFor: req.headers.get("x-forwarded-for") });
  if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });

  const parsed = parseExecRequest(await req.json().catch(() => null), DEFAULT_POLICY.maxTradeUsd);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { symbol, usd, live } = parsed.req;

  loadLocalEnv();
  if (process.env.DRY_RUN === "1" && live) return Response.json({ error: "DRY_RUN=1 is set; live broadcasts are disabled." }, { status: 400 });

  const steps: { step: string; detail?: string }[] = [];
  const { receipt, path } = await executeTrade(symbol, {
    usd,
    live,
    receiptsDir: resolve(REPO_ROOT, "receipts", "exec"),
    deps: {
      // The user already typed "yes" in the panel after reviewing the dry run; the wallet preview and simulation rails still apply.
      confirm: async () => live,
      log: (step, detail) => steps.push({ step, detail }),
    },
  });
  return Response.json({ receipt, path: path ? path.slice(REPO_ROOT.length + 1).replaceAll("\\", "/") : null, steps });
}
