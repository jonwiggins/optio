"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import {
  MAX_WORK_LINK_STATUS_URLS,
  statusableWorkLinks,
  type WorkLink,
  type WorkLinkStatus,
} from "@optio/shared";

/**
 * The state of the PRs / tickets a set of badges name, shared by every
 * badge on the page: one store keyed by URL, requests batched across all
 * mounted badge rows (a rail of twenty sessions asks once, not twenty
 * times), each URL refreshed about once a minute while something still
 * shows it and the tab is visible. The server caches too, so the cost of
 * many viewers is one host lookup per URL per minute.
 */

const REFRESH_MS = 60_000;
const BATCH_DELAY_MS = 50;

interface Entry {
  status: WorkLinkStatus | null;
  fetchedAt: number;
}

const store = new Map<string, Entry>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
/** How many mounted rows want each URL. */
const wanted = new Map<string, number>();
let pending = new Set<string>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function notify() {
  for (const fn of listeners) fn();
}

function stale(url: string, now: number): boolean {
  const entry = store.get(url);
  return !entry || now - entry.fetchedAt >= REFRESH_MS;
}

async function flush() {
  batchTimer = null;
  const urls = [...pending].filter((u) => !inflight.has(u));
  pending = new Set();
  if (urls.length === 0) return;
  for (const url of urls) inflight.add(url);
  try {
    for (let i = 0; i < urls.length; i += MAX_WORK_LINK_STATUS_URLS) {
      const chunk = urls.slice(i, i + MAX_WORK_LINK_STATUS_URLS);
      const now = Date.now();
      try {
        const { statuses } = await api.workLinkStatuses(chunk);
        const byUrl = new Map(statuses.map((s) => [s.url, s]));
        for (const url of chunk) store.set(url, { status: byUrl.get(url) ?? null, fetchedAt: now });
      } catch {
        // Keep whatever was known; try again on the next refresh.
        for (const url of chunk) {
          if (!store.has(url)) store.set(url, { status: null, fetchedAt: now });
        }
      }
    }
  } finally {
    for (const url of urls) inflight.delete(url);
    notify();
  }
}

function request(urls: string[]) {
  for (const url of urls) pending.add(url);
  if (pending.size > 0 && !batchTimer) batchTimer = setTimeout(() => void flush(), BATCH_DELAY_MS);
}

function refreshWanted() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  const now = Date.now();
  request([...wanted.keys()].filter((u) => stale(u, now)));
}

function want(urls: string[]) {
  for (const url of urls) wanted.set(url, (wanted.get(url) ?? 0) + 1);
  if (!refreshTimer) refreshTimer = setInterval(refreshWanted, REFRESH_MS);
  const now = Date.now();
  request(urls.filter((u) => stale(u, now)));
}

function unwant(urls: string[]) {
  for (const url of urls) {
    const n = (wanted.get(url) ?? 1) - 1;
    if (n <= 0) wanted.delete(url);
    else wanted.set(url, n);
  }
  if (wanted.size === 0 && refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** Test seam: forget everything. */
export function resetWorkLinkStatuses() {
  store.clear();
  inflight.clear();
  wanted.clear();
  pending = new Set();
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = null;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/** Statuses by URL for these links; a link not (yet) known is simply absent. */
export function useWorkLinkStatuses(links: WorkLink[]): Record<string, WorkLinkStatus> {
  const key = statusableWorkLinks(links)
    .map((l) => l.url)
    .join("\n");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const urls = key ? key.split("\n") : [];
    if (urls.length === 0) return;
    const onChange = () => setVersion((n) => n + 1);
    listeners.add(onChange);
    want(urls);
    return () => {
      listeners.delete(onChange);
      unwant(urls);
    };
  }, [key]);

  return useMemo(() => {
    const out: Record<string, WorkLinkStatus> = {};
    for (const url of key ? key.split("\n") : []) {
      const status = store.get(url)?.status;
      if (status?.state) out[url] = status;
    }
    return out;
    // `version` moves whenever the store does.
  }, [key, version]);
}
