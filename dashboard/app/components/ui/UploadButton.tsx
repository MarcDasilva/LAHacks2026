"use client";

import { useRef, useState } from "react";

interface Props {
  bridgeUrl: string;
  onReady: (sid: string) => void;
  fps?: number;
}

type Phase = "idle" | "uploading" | "processing" | "error";

export function UploadButton({ bridgeUrl, onReady, fps = 5 }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;

    const sid = `vid_${Date.now()}`;

    setPhase("uploading");
    setMsg(null);

    const fd = new FormData();
    fd.append("file", file);
    let res: Response;
    try {
      res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/sessions/${sid}/video?fps=${fps}`, {
        method: "POST",
        body: fd,
      });
    } catch (err) {
      setPhase("error");
      setMsg(err instanceof Error ? err.message : "upload failed");
      return;
    }
    if (!res.ok) {
      setPhase("error");
      setMsg(`upload failed: http ${res.status}`);
      return;
    }

    setPhase("processing");
    // Poll until status === "done" (or "error"). 300 * 2s = 10 min ceiling.
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const s = await fetch(`${bridgeUrl.replace(/\/$/, "")}/sessions/${sid}`).then(r => r.json());
        if (s.status === "done") {
          onReady(sid);
          setPhase("idle");
          setMsg(null);
          return;
        }
        if (s.status === "error") {
          setPhase("error");
          setMsg(s.error ?? "runner error");
          return;
        }
        setMsg(`${s.status}…`);
      } catch {
        // transient network blip; keep polling
      }
    }
    setPhase("error");
    setMsg("timeout (>10 min)");
  }

  const label =
    phase === "idle" ? "upload video" :
    phase === "uploading" ? "uploading…" :
    phase === "processing" ? (msg ?? "processing…") :
    `error: ${msg ?? "unknown"}`;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={handleFile}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={phase === "uploading" || phase === "processing"}
        className="px-3 py-1.5 bg-[var(--muted)] text-[var(--foreground)] text-xs font-mono rounded-[8px] hover:bg-[var(--border)] transition-colors disabled:opacity-70 disabled:cursor-wait whitespace-nowrap"
      >
        {label}
      </button>
    </>
  );
}
