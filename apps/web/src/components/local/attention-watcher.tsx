"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLocalFeed } from "./local-feed";
import { useBellStore } from "./bell-store";
import { useTitleStore } from "@/hooks/use-page-title";
import { faviconDataUrl, ringingBells, summarizeAttention, terminalTone } from "./attention";
import { attentionLabel } from "./terminal-card";

const DEFAULT_FAVICON = "/favicon.svg";

let currentFavicon: string | null = null;

/**
 * Swap the tab icon. Chrome only reliably repaints when the <link> node is
 * replaced (an href change on the existing node is sometimes ignored), so
 * remove and re-add. Safari ignores dynamic favicons entirely — there the
 * "(N)" title badge is the signal.
 */
function setFavicon(href: string) {
  if (currentFavicon === href) return;
  currentFavicon = href;
  for (const old of document.querySelectorAll('link[rel~="icon"]')) old.remove();
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = href.startsWith("data:") ? "image/svg+xml" : "";
  link.href = href;
  document.head.appendChild(link);
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
    // Inside a session the icon is THAT session's status; on the cockpit
    // it's the fleet's. The (N) badge is always the fleet's needs-you count.
    const m = /^\/local\/([^/?]+)/.exec(pathname);
    const focused = m ? terminals.find((t) => t.id === m[1]) : undefined;
    setFavicon(faviconDataUrl(focused ? terminalTone(focused) : summary.tone));
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
  }, [terminals, router, pathname]);

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
