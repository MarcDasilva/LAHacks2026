import { NextResponse } from "next/server";
import { createReadStream, statSync } from "fs";
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

function recordingsDir(): string {
  return path.resolve(process.cwd(), "..", "assets", "recordings");
}

function safeResolve(name: string): string | null {
  const dir = recordingsDir();
  const resolved = path.resolve(dir, name);
  if (path.dirname(resolved) !== dir) return null;
  return resolved;
}

function nodeToWeb(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream as Readable) as unknown as ReadableStream<Uint8Array>;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file: rawFile } = await params;
  const fileName = decodeURIComponent(rawFile);
  const filePath = safeResolve(fileName);
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

  const url = new URL(req.url);
  const downloadName = url.searchParams.get("download");
  const dispositionHeader: Record<string, string> = downloadName
    ? { "Content-Disposition": `attachment; filename="${path.basename(fileName)}"` }
    : {};

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
          ...dispositionHeader,
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
      ...dispositionHeader,
    },
  });
}
