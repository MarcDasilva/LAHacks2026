import { NextRequest } from "next/server";
import { bridgeUrl, readCached, safeSessionId, writeCached } from "../../_cache/cloudCache";

// Force Node.js runtime so we can use the fs module for the on-disk cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  let sessionId: string;
  try {
    sessionId = safeSessionId((await params).sessionId);
  } catch (err) {
    return new Response((err as Error).message, { status: 400 });
  }

  const conf = req.nextUrl.searchParams.get("conf");
  const downsample = req.nextUrl.searchParams.get("downsample");
  const cacheKey = `${sessionId}__cloud_c${conf ?? "default"}_d${downsample ?? "default"}.bin`;

  const cached = await readCached(cacheKey);
  if (cached) {
    return new Response(cached as unknown as BodyInit, {
      headers: {
        "content-type": "application/octet-stream",
        "x-cache": "HIT",
      },
    });
  }

  const qs: string[] = [];
  if (conf !== null) qs.push(`conf=${encodeURIComponent(conf)}`);
  if (downsample !== null) qs.push(`downsample=${encodeURIComponent(downsample)}`);
  const upstream = `${bridgeUrl()}/sessions/${sessionId}/cloud${qs.length ? `?${qs.join("&")}` : ""}`;

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
