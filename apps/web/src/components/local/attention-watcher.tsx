"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLocalFeed } from "./local-feed";
import { useBellStore } from "./bell-store";
import { useTitleStore } from "@/hooks/use-page-title";
import { faviconDataUrl, ringingBells, summarizeAttention } from "./attention";
import { attentionLabel } from "./terminal-card";

const DEFAULT_FAVICON = "/favicon.svg";

function setFavicon(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

/**
 * Mounted on every /local route. Turns the terminal feed into the things
 * you can see from another tab:
 *
 *   - favicon dot: yellow = something needs you, green = agents working,
 *     grey = quiet
 *   - "(N)" tab-title badge for the needs-you count
 *   - a browser Notification for each *armed* session (the bell in its
 *     header) the moment it flips to needs-you — unless you're already
 *     looking at it
 */
export function LocalAttentionWatcher() {
  const { terminals } = useLocalFeed();
  const pathname = usePathname();
  const router = useRouter();
  const prev = useRef<Map<string, string>>(new Map());
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  useEffect(() => {
    useBellStore.getState().hydrate();
    return () => {
      setFavicon(DEFAULT_FAVICON);
      useTitleStore.getState().setBadge(0);
    };
  }, []);

  useEffect(() => {
    const summary = summarizeAttention(terminals);
    setFavicon(faviconDataUrl(summary.tone));
    useTitleStore.getState().setBadge(summary.needsYou);

    const bells = useBellStore.getState();
    bells.prune(new Set(terminals.map((t) => t.id)));
    for (const t of ringingBells(prev.current, terminals, bells.armed)) {
      const viewing =
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        pathRef.current === `/local/${t.id}`;
      if (!viewing) notify(t, () => router.push(`/local/${t.id}`));
    }

    prev.current = new Map(terminals.map((t) => [t.id, t.attentionState]));
  }, [terminals, router]);

  return null;
}

function notify(t: any, open: () => void) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(t.title, {
      body: attentionLabel(t.attentionReason),
      tag: `local-${t.id}`,
      icon: DEFAULT_FAVICON,
    });
    n.onclick = () => {
      window.focus();
      open();
      n.close();
    };
  } catch {
    // Some browsers throw for page-scoped notifications (Android Chrome);
    // the favicon + title badge still carry the signal.
  }
}

/**
 * Ask for notification permission from a click. Returns whether the bell
 * can ring; the caller explains a "no".
 */
export async function ensureNotificationPermission(): Promise<
  "granted" | "denied" | "unsupported"
> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  const result = await Notification.requestPermission();
  return result === "granted" ? "granted" : "denied";
}
