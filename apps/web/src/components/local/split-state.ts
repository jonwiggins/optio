/**
 * Split view state lives in the URL so it survives reloads and is shareable:
 *   /local/<primary>?split=<id2>,<id3>&layout=cols|rows
 * The primary pane is the route's id (the rail's "active" session); `split`
 * lists the extra panes. At most MAX_PANES terminals are shown at once.
 */

export type SplitLayout = "cols" | "rows";
export const MAX_PANES = 3;

export interface SplitState {
  split: string[];
  layout: SplitLayout;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSplit(
  params: { get(name: string): string | null } | null | undefined,
  primary?: string,
): SplitState {
  const raw = params?.get("split") ?? "";
  const seen = new Set<string>();
  const split: string[] = [];
  for (const id of raw.split(",")) {
    const v = id.trim();
    if (!UUID_RE.test(v) || v === primary || seen.has(v)) continue;
    seen.add(v);
    split.push(v);
    if (split.length >= MAX_PANES - 1) break;
  }
  const layout = params?.get("layout") === "rows" ? "rows" : "cols";
  return { split, layout };
}

export function splitHref(primary: string, split: string[], layout: SplitLayout): string {
  const extra = split.filter((id) => id !== primary).slice(0, MAX_PANES - 1);
  const qs = new URLSearchParams();
  if (extra.length > 0) qs.set("split", extra.join(","));
  if (extra.length > 0 && layout === "rows") qs.set("layout", "rows");
  const q = qs.toString();
  return `/local/${primary}${q ? `?${q}` : ""}`;
}

/** Add `id` as an extra pane next to `primary`; drops the oldest extra when full. */
export function addToSplit(primary: string, state: SplitState, id: string): string[] {
  if (id === primary || state.split.includes(id)) return state.split;
  const next = [...state.split, id];
  return next.slice(Math.max(0, next.length - (MAX_PANES - 1)));
}
