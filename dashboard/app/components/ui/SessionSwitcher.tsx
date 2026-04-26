"use client";

import { useEffect, useState } from "react";

interface Props {
  bridgeUrl: string;
  current: string;
  onSelect: (sid: string) => void;
  /** Re-include this externally-known session even if the bridge listing fails or omits it. */
  alwaysInclude?: string;
}

interface SessionInfo {
  session_id: string;
  status: string;
}

export function SessionSwitcher({ bridgeUrl, current, onSelect, alwaysInclude }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    if (!bridgeUrl) return;
    let alive = true;
    const tick = async () => {
      try {
        const list: SessionInfo[] = await fetch(
          `${bridgeUrl.replace(/\/$/, "")}/sessions`,
        ).then(r => r.json());
        if (alive) {
          setSessions(list.filter(s => s.status === "done"));
        }
      } catch {
        // bridge unreachable; leave list as-is
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [bridgeUrl]);

  // Build option list: include current + alwaysInclude even if not in fetched list,
  // so we never end up showing a blank dropdown.
  const ids = new Set(sessions.map(s => s.session_id));
  const extras: string[] = [];
  if (current && !ids.has(current)) extras.push(current);
  if (alwaysInclude && !ids.has(alwaysInclude) && alwaysInclude !== current) {
    extras.push(alwaysInclude);
  }

  return (
    <select
      value={current}
      onChange={e => onSelect(e.target.value)}
      className="px-2 py-1.5 bg-[var(--muted)] text-[var(--foreground)] text-xs font-mono rounded-[8px] hover:bg-[var(--border)] transition-colors cursor-pointer"
    >
      {extras.map(sid => (
        <option key={sid} value={sid}>{sid}</option>
      ))}
      {sessions.map(s => (
        <option key={s.session_id} value={s.session_id}>{s.session_id}</option>
      ))}
    </select>
  );
}
