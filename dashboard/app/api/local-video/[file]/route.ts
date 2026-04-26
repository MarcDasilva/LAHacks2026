import { NextResponse } from "next/server";
import { createReadStream, statSync } from "fs";
import path from "path";
import type { ReadStream } from "fs";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

function inputDir(): string {
  // process.cwd() at runtime is dashboard/, so the repo root is one up.
  return path.resolve(process.cwd(), "..", "assets", "output", "input");
}

function safeResolve(name: string): string | null {
  // Block traversal: reject anything that escapes the input dir after
  // normalization. encodeURIComponent on the writer side gives us a flat
  // filename, but defense-in-depth still matters.
  const dir = inputDir();
  const resolved = path.resolve(dir, name);
  if (path.dirname(resolved) !== dir) return null;
  return resolved;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ file: string }> }
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
      return new NextResponse(toWebStream(stream), {
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
  return new NextResponse(toWebStream(stream), {
    status: 200,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Length": String(total),
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });
}

function toWebStream(stream: ReadStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk) => {
        controller.enqueue(chunk instanceof Buffer ? new Uint8Array(chunk) : chunk as Uint8Array);
      });
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}
