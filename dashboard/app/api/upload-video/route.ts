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
  // Local copy under assets/output/input — preferred source; cloudinary
  // (videoUrl) is the fallback if the file goes missing.
  videoLocalUrl?: string;
  videoLocalPath?: string;
  status: "ready" | "processing" | "failed";
  label?: string;
  lbmpPath?: string;
  pathPath?: string;
  points?: number;
  error?: string;
  // Gaussian splat (Modal pipeline) — fills in once train_splat finishes.
  splatStatus?: "pending" | "training" | "ready" | "failed";
  splatJobId?: string;
  splatPath?: string;
  splatError?: string;
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
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file field" }, { status: 400 });
  }

  // Primary persistence: write the upload to assets/output/input/ so the
  // dashboard, COLMAP, and any future tooling can read it straight off
  // disk. Cloudinary remains as the backup fetch path.
  const repoRoot = path.resolve(process.cwd(), "..");
  const inputDir = path.join(repoRoot, "assets", "output", "input");
  await mkdirAsync(inputDir, { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  const stamp = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const safeName = (file.name || "upload.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
  const baseName = safeName.replace(/\.[^.]+$/, "");
  const ext = (safeName.match(/\.[^.]+$/)?.[0] ?? ".mp4").toLowerCase();
  const persistedName = `${stamp}_${baseName}${ext}`;
  const persistedPath = path.join(inputDir, persistedName);
  await writeFileAsync(persistedPath, buffer);

  const videoLocalUrl = `/api/local-video/${encodeURIComponent(persistedName)}`;

  // Cloudinary upload under impulse/uploads/<stamp>_<basename>. We treat
  // this as a backup mirror — failures here don't block the flow because
  // the local file is the primary playback source now.
  const cloudinaryPublicId = `impulse/uploads/${stamp}_${baseName}`;
  let secureUrl = videoLocalUrl;
  if (configureCloudinary()) {
    try {
      const result = await cloudinary.uploader.upload(persistedPath, {
        resource_type: "video",
        public_id: cloudinaryPublicId,
        overwrite: true,
        invalidate: true,
      });
      secureUrl = result.secure_url;
    } catch (e) {
      // Non-fatal: keep the local copy as the only source of truth.
      console.warn("[upload-video] cloudinary mirror failed:", e instanceof Error ? e.message : e);
    }
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
    videoLocalUrl,
    videoLocalPath: persistedPath,
    status: "processing",
    label,
    lbmpPath: `/clouds/splats/${videoId}/sparse.lbmp`,
    pathPath: `/clouds/splats/${videoId}/sparse.path.json`,
    splatStatus: "pending",
  };
  await writeManifest(manifestPath, manifest);

  // Kick off Modal 3DGS training in parallel. The web endpoint returns a
  // call_id we persist so the dashboard's poll route can drain the result
  // when training finishes (~5–10 min on a warm A100).
  void (async () => {
    const base = process.env.MODAL_SPLAT_URL?.replace(/\/$/, "");
    if (!base) return;
    try {
      const res = await fetch(`${base}/spawn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.IMPULSE_SPLAT_TOKEN
            ? { authorization: `Bearer ${process.env.IMPULSE_SPLAT_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({ video_url: secureUrl }),
      });
      if (!res.ok) throw new Error(`spawn ${res.status}`);
      const { call_id } = (await res.json()) as { call_id: string };
      const m2 = await readManifest(manifestPath);
      const rec = m2.videos[videoId];
      if (rec) {
        rec.splatJobId = call_id;
        rec.splatStatus = "training";
        await writeManifest(manifestPath, m2);
      }
    } catch (e) {
      const m2 = await readManifest(manifestPath);
      const rec = m2.videos[videoId];
      if (rec) {
        rec.splatStatus = "failed";
        rec.splatError = e instanceof Error ? e.message : "modal spawn failed";
        await writeManifest(manifestPath, m2);
      }
    }
  })();

  // Spawn the COLMAP subprocess detached — the API responds immediately,
  // process_video.py keeps running and updates the manifest when done.
  // process.cwd() at runtime is the dashboard/ project root; the script
  // lives one level up.
  const scriptPath = path.join(repoRoot, "scripts", "process_video.py");
  const logDir = path.join(os.tmpdir(), `impulse_upload_${stamp}`);
  await mkdirAsync(logDir, { recursive: true });
  const logPath = path.join(logDir, "process.log");

  const fs = await import("fs");

  const splatChild = spawn(
    "python3",
    [
      scriptPath,
      "--video", persistedPath,
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
    const out = fs.createWriteStream(logPath, { flags: "a" });
    splatChild.stdout?.pipe(out);
    splatChild.stderr?.pipe(out);
  } catch {
    /* logging is best-effort */
  }
  splatChild.unref();

  // Kick off semantic indexing in parallel with COLMAP. The indexer only
  // needs the Cloudinary URL + OpenAI key, so it doesn't fight the splat
  // pipeline for resources. Targets just this video by public_id.
  const indexLogPath = path.join(logDir, "index.log");
  const indexerPath = path.join(repoRoot, "scripts", "index_videos.py");
  const indexChild = spawn(
    "python3",
    [indexerPath, "--public-id", cloudinaryPublicId],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }
  );
  try {
    const out = fs.createWriteStream(indexLogPath, { flags: "a" });
    indexChild.stdout?.pipe(out);
    indexChild.stderr?.pipe(out);
  } catch {
    /* logging is best-effort */
  }
  indexChild.unref();

  return NextResponse.json({
    videoId,
    videoUrl: secureUrl,
    videoLocalUrl,
    status: "processing",
    label,
    logPath,
  });
}
