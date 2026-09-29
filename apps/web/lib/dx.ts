export interface DxEntry {
  n: number;
  date: string;
  area: string;
  severity: string;
  summary: string;
  title: string | null;
  slug: string | null;
}

/** GitHub's heading anchor: lowercase, drop everything but letters, digits, spaces and hyphens, spaces to hyphens. */
export function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}

/** Reads the summary table (`| # | Date | Area | Severity | Summary |`) and the `## N. Title` headings of DX_LOG.md. */
export function parseDxLog(md: string): DxEntry[] {
  const headings = new Map<number, string>();
  for (const m of md.matchAll(/^## (\d+)\. (.+)$/gm)) headings.set(Number(m[1]), `${m[1]}. ${m[2]!.trim()}`);
  const entries: DxEntry[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    const heading = headings.get(n) ?? null;
    entries.push({
      n,
      date: m[2]!.trim(),
      area: m[3]!.trim(),
      severity: m[4]!.trim(),
      summary: m[5]!.trim(),
      title: heading ? heading.replace(/^\d+\.\s*/, "") : null,
      slug: heading ? githubSlug(heading) : null,
    });
  }
  return entries;
}

/** Splits `code` spans out of a Markdown string so the page can render them without a Markdown library. */
export function codeSpans(s: string): { text: string; code: boolean }[] {
  return s.split(/(`[^`]+`)/).filter(Boolean).map((p) => (p.startsWith("`") && p.endsWith("`") ? { text: p.slice(1, -1), code: true } : { text: p, code: false }));
}
