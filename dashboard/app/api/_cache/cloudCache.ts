import { promises as fs } from "fs";
import path from "path";

// Cache lives alongside the running Next.js process. `npm run dev` / `next start`
// both run from `dashboard/`, so this resolves to `dashboard/.cloud-cache/`.
const CACHE_ROOT = path.join(process.cwd(), ".cloud-cache");

const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

export function safeSessionId(sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
  return sessionId;
}

export function cachePath(filename: string): string {
  return path.join(CACHE_ROOT, filename);
}

export async function readCached(filename: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(cachePath(filename));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeCached(filename: string, data: Buffer): Promise<void> {
  await fs.mkdir(CACHE_ROOT, { recursive: true });
  const final = cachePath(filename);
  // Atomic write: stream to .tmp then rename, so a crashed/aborted fetch
  // never leaves a half-written file that future reads would treat as valid.
  const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, final);
}

export function bridgeUrl(): string {
  const u = process.env.NEXT_PUBLIC_BRIDGE_URL ?? "";
  if (!u) throw new Error("NEXT_PUBLIC_BRIDGE_URL not set");
  return u.replace(/\/$/, "");
}
