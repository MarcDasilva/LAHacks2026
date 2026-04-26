import { NextResponse } from "next/server";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RecordingEntry = {
  id: string;
  name: string;
  url: string;
  bytes: number;
  createdAt: string;
  roomId: string | null;
};

const VIDEO_EXTS = new Set([".webm", ".mp4", ".m4v", ".mov", ".mkv"]);

function recordingsDir(): string {
  return path.resolve(process.cwd(), "..", "assets", "recordings");
}

function sanitizeRoom(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 64) || "room";
}

function parseRoomFromName(name: string): string | null {
  const stem = name.replace(/\.[^.]+$/, "");
  const idx = stem.indexOf("_");
  if (idx <= 0) return null;
  return stem.slice(idx + 1) || null;
}

function listRecordings(): RecordingEntry[] {
  const dir = recordingsDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RecordingEntry[] = [];
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
      id: name,
      name,
      url: `/api/recordings/${encodeURIComponent(name)}`,
      bytes: stat.size,
      createdAt: stat.mtime.toISOString(),
      roomId: parseRoomFromName(name),
    });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export async function GET() {
  return NextResponse.json({ recordings: listRecordings() });
}

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const roomRaw = form.get("roomId");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "missing file" }, { status: 400 });
  }
  const roomId = sanitizeRoom(typeof roomRaw === "string" && roomRaw ? roomRaw : "room");

  const mime = file.type || "video/webm";
  const ext = mime.includes("mp4") ? ".mp4" : ".webm";
  const fileName = `${Date.now()}_${roomId}${ext}`;

  const dir = recordingsDir();
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, fileName);

  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(target, buf);

  const stat = statSync(target);
  const entry: RecordingEntry = {
    id: fileName,
    name: fileName,
    url: `/api/recordings/${encodeURIComponent(fileName)}`,
    bytes: stat.size,
    createdAt: stat.mtime.toISOString(),
    roomId,
  };
  return NextResponse.json(entry);
}
