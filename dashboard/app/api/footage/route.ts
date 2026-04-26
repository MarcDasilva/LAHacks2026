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
  // Try repo-root .env, then dashboard/.env.local. Next.js only auto-loads
  // the latter, but we keep the source of truth one level up so the python
  // scripts and the API share a single file.
  for (const envPath of [
    path.join(process.cwd(), "..", ".env"),
    path.join(process.cwd(), ".env.local"),
  ]) {
    try {
      const text = readFileSync(envPath, "utf8");
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/i);
        if (!m) continue;
        const [, key, valueRaw] = m;
        if (process.env[key]) continue;
        process.env[key] = valueRaw.replace(/^["']|["']$/g, "");
      }
    } catch {
      /* missing — try the next */
    }
  }
}

function configureCloudinary(): boolean {
  ensureCloudinaryEnv();
  const url = process.env.CLOUDINARY_URL;
  if (!url) return false;
  // The SDK's auto-config from CLOUDINARY_URL is unreliable inside the
  // Next.js server (the env can be sealed before the lazy init runs), so
  // parse the URL ourselves and call config() with explicit fields.
  const m = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+?)\/?$/);
  if (!m) return false;
  cloudinary.config({
    cloud_name: m[3],
    api_key: m[1],
    api_secret: m[2],
    secure: true,
  });
  return true;
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
  if (!configureCloudinary()) {
    return NextResponse.json(
      { videos: [], error: "CLOUDINARY_URL not configured" },
      { status: 200 }
    );
  }

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
