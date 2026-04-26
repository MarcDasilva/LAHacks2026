import { NextResponse } from "next/server";
import { readFileSync, readdirSync, statSync } from "fs";
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

type FootageEntry = {
  id: string;
  name: string;
  url: string;
  bytes: number;
  durationSec: number | null;
  createdAt: string | null;
  source: "local" | "cloudinary";
};

const VIDEO_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv"]);

function listLocalInputs(): FootageEntry[] {
  const dir = path.resolve(process.cwd(), "..", "assets", "output", "input");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: FootageEntry[] = [];
  for (const name of names) {
    if (!VIDEO_EXTS.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      id: `local/${name}`,
      name,
      url: `/api/local-video/${encodeURIComponent(name)}`,
      bytes: stat.size,
      durationSec: null,
      createdAt: stat.mtime.toISOString(),
      source: "local",
    });
  }
  out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return out;
}

export async function GET() {
  const local = listLocalInputs();

  if (!configureCloudinary()) {
    // Cloudinary is the backup; if it's not configured, just serve local.
    return NextResponse.json({ videos: local });
  }

  let cloudVideos: FootageEntry[] = [];
  let cloudError: string | null = null;
  try {
    const result = (await cloudinary.api.resources({
      resource_type: "video",
      type: "upload",
      max_results: 100,
      prefix: "impulse/",
    })) as { resources?: CloudinaryVideo[] };

    cloudVideos = (result.resources ?? []).map<FootageEntry>((r) => ({
      id: r.public_id,
      name: r.public_id.split("/").pop() ?? r.public_id,
      url: r.secure_url,
      bytes: r.bytes ?? 0,
      durationSec: r.duration ?? null,
      createdAt: r.created_at ?? null,
      source: "cloudinary",
    }));
    cloudVideos.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  } catch (e) {
    cloudError = e instanceof Error ? e.message : "cloudinary error";
  }

  // Local entries come first; Cloudinary entries are deduplicated against
  // local matches by basename so we don't show the same video twice.
  const localBaseNames = new Set(local.map((v) => v.name.replace(/\.[^.]+$/, "")));
  const dedupedCloud = cloudVideos.filter((v) => !localBaseNames.has(v.name));
  const videos = [...local, ...dedupedCloud];

  return NextResponse.json({
    videos,
    ...(cloudError ? { error: cloudError } : {}),
  });
}
