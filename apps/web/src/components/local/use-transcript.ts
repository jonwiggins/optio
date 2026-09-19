"use client";

import { useEffect, useRef, useState } from "react";
import type { LocalTranscriptEntry } from "@optio/shared";
import { api } from "@/lib/api-client";

const LIVE_POLL_MS = 4000;
const PAGE = 2000;

/**
 * A terminal's stored conversation: everything at mount (paged), then —
 * while `live` — only the entries past the last seq every few seconds.
 * `loaded` flips once the first fetch settles, so callers can decide the
 * default view (transcript vs. screen) without a flash of the wrong one.
 */
export function useLocalTranscript(
  terminalId: string,
  live: boolean,
): { entries: LocalTranscriptEntry[]; loaded: boolean } {
  const [entries, setEntries] = useState<LocalTranscriptEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const lastSeq = useRef(0);
  const inflight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    lastSeq.current = 0;
    setEntries([]);
    setLoaded(false);
    (async () => {
      const all: LocalTranscriptEntry[] = [];
      try {
        // Page until the server says it handed over everything.
        for (let after = 0; ; ) {
          const res = await api.getLocalTerminalTranscript(terminalId, { after, limit: PAGE });
          if (cancelled) return;
          all.push(...res.entries);
          if (res.complete || res.entries.length === 0) break;
          after = res.entries[res.entries.length - 1]!.seq;
        }
      } catch {
        // No transcript (older row, non-agent session) — the screen view stands in.
      }
      if (cancelled) return;
      lastSeq.current = all.length ? all[all.length - 1]!.seq : 0;
      setEntries(all);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [terminalId]);

  // Entries past the last seq. Shared by the live poll and the one extra
  // fetch after the session ends (the daemon flushes the final turn right
  // before `exit`, after the last poll may have run).
  const fetchMore = useRef<() => Promise<void>>(async () => {});
  fetchMore.current = async () => {
    if (inflight.current || document.visibilityState !== "visible") return;
    inflight.current = true;
    try {
      const res = await api.getLocalTerminalTranscript(terminalId, {
        after: lastSeq.current,
        limit: PAGE,
      });
      if (res.entries.length === 0) return;
      lastSeq.current = res.entries[res.entries.length - 1]!.seq;
      setEntries((prev) => [...prev, ...res.entries]);
    } catch {
      // transient — the next tick retries
    } finally {
      inflight.current = false;
    }
  };

  useEffect(() => {
    if (!loaded) return;
    if (!live) {
      void fetchMore.current();
      return;
    }
    const timer = setInterval(() => void fetchMore.current(), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [terminalId, live, loaded]);

  return { entries, loaded };
}
