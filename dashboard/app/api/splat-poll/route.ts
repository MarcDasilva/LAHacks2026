import { NextResponse } from "next/server";
import { mkdir, writeFile, readFile, readFileSync } from "fs";
import { promisify } from "util";
import path from "path";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const writeFileAsync = promisify(writeFile);
const mkdirAsync = promisify(mkdir);
const readFileAsync = promisify(readFile);

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

type ManifestRecord = {
  videoId: string;
  videoUrl: string;
  status: "ready" | "processing" | "failed";
  label?: string;
  lbmpPath?: string;
  pathPath?: string;
  points?: number;
  error?: string;
  splatStatus?: "pending" | "training" | "ready" | "failed";
  splatJobId?: string;
  splatPath?: string;
  splatError?: string;
  indexStatus?: "pending" | "ready" | "failed";
  indexError?: string;
};
type Manifest = { version: number; videos: Record<string, ManifestRecord> };

const MANIFEST_PATH = path.join(
  process.cwd(),
  "public",
  "clouds",
  "splats",
  "manifest.json"
);

const SEARCH_INDEX_PATH = path.join(
  process.cwd(),
  "public",
  "clouds",
  "search_index.json"
);

function normalizeVideoId(id: string): string {
  return id.replace(/[\/\\]/g, "__");
}

type SearchIndex = {
  entries?: Array<{ videoId?: string }>;
};

// Walks search_index.json once and flips indexStatus → "ready" for every
// pending record whose videoId now has indexed entries. Cheap because the
// index is small JSON and we only read it when at least one record is
// pending.
async function reconcileIndexStatus(manifest: Manifest): Promise<Manifest> {
  const pendingIds = Object.values(manifest.videos)
    .filter((r) => r.indexStatus === "pending")
    .map((r) => r.videoId);
  if (pendingIds.length === 0) return manifest;

  let index: SearchIndex;
  try {
    const buf = await readFileAsync(SEARCH_INDEX_PATH, "utf8");
    index = JSON.parse(buf) as SearchIndex;
  } catch {
    return manifest;
  }
  const indexed = new Set<string>();
  for (const e of index.entries ?? []) {
    if (e.videoId) indexed.add(normalizeVideoId(e.videoId));
  }
  let dirty = false;
  for (const id of pendingIds) {
    if (indexed.has(id)) {
      const rec = manifest.videos[id];
      if (rec) {
        rec.indexStatus = "ready";
        dirty = true;
      }
    }
  }
  if (dirty) {
    await writeManifestAtomic(manifest);
  }
  return manifest;
}

async function readManifest(): Promise<Manifest> {
  try {
    const buf = await readFileAsync(MANIFEST_PATH, "utf8");
    return JSON.parse(buf) as Manifest;
  } catch {
    return { version: 1, videos: {} };
  }
}

async function writeManifestAtomic(manifest: Manifest): Promise<void> {
  await mkdirAsync(path.dirname(MANIFEST_PATH), { recursive: true });
  await writeFileAsync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

// Drains every record whose Modal training job is in-flight. For each:
//   - GET <MODAL_SPLAT_URL>/result/<call_id>
//   - 202: still training; leave alone
//   - 200: write bytes to public/clouds/splats/<videoId>/scene.splat,
//          mark splatStatus = "ready"
//   - else: mark splatStatus = "failed"
async function drain(): Promise<Manifest> {
  ensureEnv();
  const base = process.env.MODAL_SPLAT_URL?.replace(/\/$/, "");
  let manifest = await readManifest();
  if (!base) return manifest;

  const pending = Object.values(manifest.videos).filter(
    (r) => r.splatJobId && r.splatStatus !== "ready" && r.splatStatus !== "failed"
  );
  if (pending.length === 0) return manifest;

  const headers: Record<string, string> = {};
  if (process.env.IMPULSE_SPLAT_TOKEN) {
    headers.authorization = `Bearer ${process.env.IMPULSE_SPLAT_TOKEN}`;
  }

  for (const rec of pending) {
    try {
      const res = await fetch(`${base}/result/${rec.splatJobId}`, {
        headers,
        cache: "no-store",
      });
      if (res.status === 202) continue;
      if (!res.ok) throw new Error(`result ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const outDir = path.join(
        process.cwd(),
        "public",
        "clouds",
        "splats",
        rec.videoId
      );
      await mkdirAsync(outDir, { recursive: true });
      const outFile = path.join(outDir, "scene.splat");
      await writeFileAsync(outFile, buf);
      manifest = await readManifest();
      const live = manifest.videos[rec.videoId];
      if (live) {
        live.splatPath = `/clouds/splats/${rec.videoId}/scene.splat`;
        live.splatStatus = "ready";
        await writeManifestAtomic(manifest);
      }
    } catch (e) {
      manifest = await readManifest();
      const live = manifest.videos[rec.videoId];
      if (live) {
        live.splatStatus = "failed";
        live.splatError = e instanceof Error ? e.message : "modal result failed";
        await writeManifestAtomic(manifest);
      }
    }
  }
  return manifest;
}

export async function GET() {
  const drained = await drain();
  const manifest = await reconcileIndexStatus(drained);
  return NextResponse.json(manifest, {
    headers: { "cache-control": "no-store" },
  });
}
