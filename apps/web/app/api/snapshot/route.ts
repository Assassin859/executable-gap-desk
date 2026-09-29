import { SNAPSHOT } from "@/lib/snapshot";

export const dynamic = "force-static";

export function GET() {
  return Response.json(SNAPSHOT, { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } });
}
