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

// Our own <link>, kept apart from the one Next renders from the layout
// metadata. That node belongs to React: removing it out from under React
// throws "Cannot read properties of null (reading 'removeChild')" on the
// next client navigation and the route change never lands.
const OWN_ATTR = "data-optio-favicon";

/**
 * Swap the tab icon. Chrome only reliably repaints when a <link> node is
 * inserted (an href change on the existing node is sometimes ignored), so
 * we replace our own node each time and leave React's alone. Ours is
 * appended last, so it wins while present; removing it hands the tab back
 * to the default. Safari ignores dynamic favicons entirely — there the
 * "(N)" title badge is the signal.
 */
function setFavicon(href: string | null) {
  if (currentFavicon === href) return;
  currentFavicon = href;
  for (const old of document.head.querySelectorAll(`link[${OWN_ATTR}]`)) old.remove();
  if (!href) return;
  const link = document.createElement("link");
  link.setAttribute(OWN_ATTR, "");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = href;
  document.head.appendChild(link);
}

/**
 * Mounted on /work and every /local/:id route. Turns the terminal feed into the things
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
      setFavicon(null);
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
