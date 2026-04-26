import { NextRequest } from "next/server";
import { bridgeUrl, readCached, safeSessionId, writeCached } from "../../_cache/cloudCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  let sessionId: string;
  try {
    sessionId = safeSessionId((await params).sessionId);
  } catch (err) {
    return new Response((err as Error).message, { status: 400 });
  }

  const cacheKey = `${sessionId}__frustums.bin`;

  const cached = await readCached(cacheKey);
  if (cached) {
    return new Response(cached as unknown as BodyInit, {
      headers: {
        "content-type": "application/octet-stream",
        "x-cache": "HIT",
      },
    });
  }

  const upstream = `${bridgeUrl()}/sessions/${sessionId}/frustums`;
  const res = await fetch(upstream);
  if (!res.ok) {
    return new Response(`bridge ${res.status}`, { status: res.status });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeCached(cacheKey, buf);

  return new Response(buf as unknown as BodyInit, {
    headers: {
      "content-type": "application/octet-stream",
      "x-cache": "MISS",
    },
  });
}
