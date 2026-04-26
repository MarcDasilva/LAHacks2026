import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import path from "path";
import { v2 as cloudinary } from "cloudinary";

// Cloudinary admin API call — runs server-side so the API secret never
// reaches the browser.
export const dynamic = "force-dynamic";

let envLoaded = false;
function ensureCloudinaryEnv() {
  if (envLoaded) return;
  envLoaded = true;
  if (process.env.CLOUDINARY_URL) return;
  // dashboard/.env.local does not carry CLOUDINARY_URL; load it from the
  // repo-root .env that the python script also reads.
  try {
    const envPath = path.join(process.cwd(), "..", ".env");
    const text = readFileSync(envPath, "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/i);
      if (!m) continue;
      const [, key, valueRaw] = m;
      if (key !== "CLOUDINARY_URL") continue;
      process.env.CLOUDINARY_URL = valueRaw.replace(/^["']|["']$/g, "");
      break;
    }
  } catch {
    /* file missing — fall through */
  }
}

type CloudinaryVideo = {
  public_id: string;
  secure_url: string;
  bytes?: number;
  duration?: number;
  created_at?: string;
  width?: number;
  height?: number;
};

export async function GET() {
  ensureCloudinaryEnv();
  if (!process.env.CLOUDINARY_URL) {
    return NextResponse.json(
      { videos: [], error: "CLOUDINARY_URL not configured" },
      { status: 200 }
    );
  }

  cloudinary.config(); // auto-reads CLOUDINARY_URL

  try {
    const result = (await cloudinary.api.resources({
      resource_type: "video",
      type: "upload",
      max_results: 100,
      prefix: "impulse/",
    })) as { resources?: CloudinaryVideo[] };

    const videos = (result.resources ?? []).map((r) => ({
      id: r.public_id,
      name: r.public_id.split("/").pop() ?? r.public_id,
      url: r.secure_url,
      bytes: r.bytes ?? 0,
      durationSec: r.duration ?? null,
      createdAt: r.created_at ?? null,
    }));
    videos.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    return NextResponse.json({ videos });
  } catch (e) {
    const message = e instanceof Error ? e.message : "cloudinary error";
    return NextResponse.json({ videos: [], error: message }, { status: 500 });
  }
}
