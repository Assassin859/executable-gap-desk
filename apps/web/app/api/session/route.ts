import { liveSession } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await liveSession();
    return Response.json({ session }, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } });
  } catch (err) {
    return Response.json({ session: null, error: err instanceof Error ? err.message : "session unavailable" }, { status: 502 });
  }
}
