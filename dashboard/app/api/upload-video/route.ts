import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { mkdir, writeFile, readFile, readFileSync } from "fs";
import { promisify } from "util";
import path from "path";
import os from "os";
import crypto from "crypto";
import { v2 as cloudinary } from "cloudinary";

export const dynamic = "force-dynamic";
// Allow up to a few minutes for the upload + cloudinary handoff.
export const maxDuration = 300;

const writeFileAsync = promisify(writeFile);
const mkdirAsync = promisify(mkdir);
const readFileAsyncRaw = promisify(readFile);

let envLoaded = false;
function ensureEnv() {
  if (envLoaded) return;
  envLoaded = true;
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
  ensureEnv();
  const url = process.env.CLOUDINARY_URL;
  if (!url) return false;
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

function publicIdToVideoId(publicId: string): string {
  return publicId.replace(/[\/\\]/g, "__");
}

type ManifestRecord = {
  videoId: string;
  videoUrl: string;
  status: "ready" | "processing" | "failed";
  label?: string;
  lbmpPath?: string;
  pathPath?: string;
  points?: number;
  error?: string;
};

type Manifest = { version: number; videos: Record<string, ManifestRecord> };

async function readManifest(manifestPath: string): Promise<Manifest> {
  try {
    const buf = await readFileAsyncRaw(manifestPath, "utf8");
    return JSON.parse(buf) as Manifest;
  } catch {
    return { version: 1, videos: {} };
  }
}

async function writeManifest(manifestPath: string, manifest: Manifest): Promise<void> {
  await mkdirAsync(path.dirname(manifestPath), { recursive: true });
  await writeFileAsync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

export async function POST(req: Request) {
  if (!configureCloudinary()) {
    return NextResponse.json(
      { error: "CLOUDINARY_URL not configured" },
      { status: 500 }
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file field" }, { status: 400 });
  }

  // Persist the upload to a temp file we can hand to both Cloudinary and
  // the COLMAP subprocess.
  const buffer = Buffer.from(await file.arrayBuffer());
  const stamp = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const safeName = (file.name || "upload.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
  const tmpDir = path.join(os.tmpdir(), `impulse_upload_${stamp}`);
  await mkdirAsync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, safeName);
  await writeFileAsync(tmpPath, buffer);

  // Upload to Cloudinary under impulse/uploads/<stamp>_<basename>.
  const baseName = safeName.replace(/\.[^.]+$/, "");
  const cloudinaryPublicId = `impulse/uploads/${stamp}_${baseName}`;
  let secureUrl: string;
  try {
    const result = await cloudinary.uploader.upload(tmpPath, {
      resource_type: "video",
      public_id: cloudinaryPublicId,
      overwrite: true,
      invalidate: true,
    });
    secureUrl = result.secure_url;
  } catch (e) {
    const message = e instanceof Error ? e.message : "cloudinary upload failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const videoId = publicIdToVideoId(cloudinaryPublicId);
  const label = baseName;

  // Mark the manifest entry as processing immediately so the dashboard
  // can show 'Building sparse splat…' before COLMAP exits.
  const manifestPath = path.join(
    process.cwd(),
    "public",
    "clouds",
    "splats",
    "manifest.json"
  );
  const manifest = await readManifest(manifestPath);
  manifest.videos[videoId] = {
    videoId,
    videoUrl: secureUrl,
    status: "processing",
    label,
    lbmpPath: `/clouds/splats/${videoId}/sparse.lbmp`,
    pathPath: `/clouds/splats/${videoId}/sparse.path.json`,
  };
  await writeManifest(manifestPath, manifest);

  // Spawn the COLMAP subprocess detached — the API responds immediately,
  // process_video.py keeps running and updates the manifest when done.
  // process.cwd() at runtime is the dashboard/ project root; the script
  // lives one level up.
  const repoRoot = path.resolve(process.cwd(), "..");
  const scriptPath = path.join(repoRoot, "scripts", "process_video.py");
  const logPath = path.join(tmpDir, "process.log");

  const child = spawn(
    "python3",
    [
      scriptPath,
      "--video", tmpPath,
      "--video-id", videoId,
      "--video-url", secureUrl,
      "--label", label,
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }
  );
  // Best-effort log piping for debugging; the subprocess survives even
  // if these streams close when the API request finishes.
  try {
    const fs = await import("fs");
    const out = fs.createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
  } catch {
    /* logging is best-effort */
  }
  child.unref();

  return NextResponse.json({
    videoId,
    videoUrl: secureUrl,
    status: "processing",
    label,
    logPath,
  });
}
