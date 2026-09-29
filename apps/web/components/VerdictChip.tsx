import type { Verdict } from "@gapdesk/core";

const STYLE: Record<Verdict, string> = {
  GO: "bg-go/15 text-go ring-go/40",
  CAUTION: "bg-caution/15 text-caution ring-caution/40",
  BLOCK: "bg-block/15 text-block ring-block/40",
};

export function VerdictChip({ verdict, small = false }: { verdict: Verdict; small?: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-md font-semibold ring-1 ring-inset ${STYLE[verdict]} ${small ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-xs"}`}>
      {verdict}
    </span>
  );
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  GO: "text-go",
  CAUTION: "text-caution",
  BLOCK: "text-block",
};
