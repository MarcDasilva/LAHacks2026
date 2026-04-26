import { NextResponse } from "next/server";
import { readFile, readFileSync } from "fs";
import { promisify } from "util";
import path from "path";

export const dynamic = "force-dynamic";

const readFileAsync = promisify(readFile);
const OPENAI_BASE = "https://api.openai.com/v1";
const EMBED_MODEL = "text-embedding-3-small";

type IndexEntry = {
  videoId: string;
  videoUrl: string;
  startSec: number;
  endSec: number;
  caption: string;
  embedding: number[];
};

type IndexFile = {
  version: number;
  model: string;
  entries: IndexEntry[];
};

function ensureOpenAIEnv() {
  if (process.env.OPENAI_API_KEY) return;

  const envPaths = [
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "..", ".env.local"),
    path.join(process.cwd(), "..", ".env"),
    path.join(process.cwd(), "..", "..", ".env.local"),
    path.join(process.cwd(), "..", "..", ".env"),
  ];

  for (const envPath of envPaths) {
    try {
      const text = readFileSync(envPath, "utf8");
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/i);
        if (!m) continue;
        const [, key, valueRaw] = m;
        if (key !== "OPENAI_API_KEY") continue;
        process.env.OPENAI_API_KEY = valueRaw.replace(/^["']|["']$/g, "");
        return;
      }
    } catch {
      /* try the next candidate path */
    }
  }
}

async function loadIndex(): Promise<IndexFile> {
  // Resolve relative to the dashboard/ project root regardless of where
  // Next.js was launched from.
  const indexPath = path.join(process.cwd(), "public", "clouds", "search_index.json");
  const buf = await readFileAsync(indexPath, "utf8");
  return JSON.parse(buf) as IndexFile;
}

async function embedQuery(query: string, apiKey: string): Promise<number[]> {
  const res = await fetch(`${OPENAI_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: query }),
  });
  if (!res.ok) {
    throw new Error(`openai embed ${res.status}: ${await res.text()}`);
  }
  const payload = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const values = payload.data?.[0]?.embedding;
  if (!values?.length) throw new Error("openai returned empty embedding");
  return values;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function normalizeVideoId(id: string): string {
  return id.replace(/[\/\\]/g, "__");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? 6)));
  const videoFilter = url.searchParams.get("video")?.trim() || null;

  if (!q) {
    return NextResponse.json({ results: [], error: "missing q" }, { status: 400 });
  }

  ensureOpenAIEnv();
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { results: [], error: "OPENAI_API_KEY not configured" },
      { status: 500 }
    );
  }

  let index: IndexFile;
  try {
    index = await loadIndex();
  } catch (e) {
    const message = e instanceof Error ? e.message : "index load failed";
    return NextResponse.json(
      { results: [], error: `${message} — run scripts/index_videos.py first` },
      { status: 200 }
    );
  }

  if (!index.entries.length) {
    return NextResponse.json({ results: [], error: "index is empty" });
  }

  // Old index entries store the raw cloudinary public_id ("impulse/foo");
  // newer ones use the manifest-style normalised form ("impulse__foo").
  // Compare both so a videoId filter works against either.
  const filteredEntries = videoFilter
    ? index.entries.filter(
        (e) =>
          e.videoId === videoFilter ||
          normalizeVideoId(e.videoId) === videoFilter
      )
    : index.entries;

  if (videoFilter && filteredEntries.length === 0) {
    return NextResponse.json({
      query: q,
      videoFilter,
      results: [],
      error: "no indexed segments for this video — run scripts/index_videos.py",
    });
  }

  let queryVec: number[];
  try {
    queryVec = await embedQuery(q, process.env.OPENAI_API_KEY);
  } catch (e) {
    const message = e instanceof Error ? e.message : "embed failed";
    return NextResponse.json({ results: [], error: message }, { status: 502 });
  }

  const ranked = filteredEntries
    .map((entry) => ({
      videoId: normalizeVideoId(entry.videoId),
      videoUrl: entry.videoUrl,
      startSec: entry.startSec,
      endSec: entry.endSec,
      caption: entry.caption,
      score: cosine(queryVec, entry.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return NextResponse.json({ query: q, videoFilter, results: ranked });
}
