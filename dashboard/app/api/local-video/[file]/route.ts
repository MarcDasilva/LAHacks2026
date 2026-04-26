import { NextResponse } from "next/server";
import { createReadStream, existsSync, statSync } from "fs";
import { Readable } from "stream";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

function inputDir(): string {
  // process.cwd() at runtime is the dashboard project root.
  return path.resolve(process.cwd(), "..", "assets", "output", "input");
}

function safeResolve(name: string): string | null {
  const dir = inputDir();
  const resolved = path.resolve(dir, name);
  if (path.dirname(resolved) !== dir) return null;
  return resolved;
}

function previewNameFor(name: string): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${stem}.preview.mp4`;
}

function resolvePlayablePath(fileName: string): string | null {
  const originalPath = safeResolve(fileName);
  if (!originalPath) return null;

  if (!/\.preview\.mp4$/i.test(fileName)) {
    const previewPath = safeResolve(previewNameFor(fileName));
    if (previewPath && existsSync(previewPath)) return previewPath;
  }

  return originalPath;
}

function nodeToWeb(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  // Readable.toWeb exists in Node 18+ but its types lag in some setups —
  // cast to a typed return so consumers get Uint8Array chunks.
  return Readable.toWeb(stream as Readable) as unknown as ReadableStream<Uint8Array>;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ file: string }> }
) {
  const { file: rawFile } = await params;
  const fileName = decodeURIComponent(rawFile);
  const filePath = resolvePlayablePath(fileName);
  if (!filePath) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const total = stat.size;
  const range = req.headers.get("range");

  // Browser <video> tags need Range support to seek; without 206 responses
  // Safari in particular refuses to load the file at all.
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${total}` },
        });
      }
      const chunkSize = end - start + 1;
      const stream = createReadStream(filePath, { start, end });
      return new NextResponse(nodeToWeb(stream), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunkSize),
          "Content-Type": contentType,
          "Cache-Control": "no-store",
        },
      });
    }
  }

  const stream = createReadStream(filePath);
  return new NextResponse(nodeToWeb(stream), {
    status: 200,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Length": String(total),
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });
}
