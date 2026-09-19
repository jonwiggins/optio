/**
 * Pure helpers behind "the PTY follows whoever is using it".
 *
 * One PTY has one grid. Viewers that interact (click/tap into the terminal,
 * type) claim it and size it to their own screen; viewers that are only
 * watching render the owner's grid shrunk to fit their width instead of
 * fighting over the PTY. Kept DOM-free so the arithmetic is unit-testable.
 */

export const BASE_FONT_PX = 13;
/** Below this the text is a texture, not a terminal — stop shrinking. */
export const MIN_PASSIVE_FONT_PX = 5;

export interface Grid {
  cols: number;
  rows: number;
}

export function sameGrid(a: Grid | null | undefined, b: Grid | null | undefined): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}

/**
 * Font size that fits `cols` columns into `availableWidthPx`, given the
 * font's cell width as a fraction of its size (≈0.6 for typical monospace;
 * measured from the renderer when available). Never larger than the base
 * size — a passive phone showing a 60-column laptop grid still gets the
 * normal font, only oversize grids shrink.
 */
export function passiveFontPx(
  availableWidthPx: number,
  cols: number,
  cellWidthPerFontPx: number,
  base = BASE_FONT_PX,
  min = MIN_PASSIVE_FONT_PX,
): number {
  if (!(availableWidthPx > 0) || !(cols > 0) || !(cellWidthPerFontPx > 0)) return base;
  const fits = Math.floor(availableWidthPx / (cols * cellWidthPerFontPx));
  return Math.max(min, Math.min(base, fits));
}

export type SizingMode =
  /** No one has claimed the grid yet — render at our own natural fit. */
  | { kind: "unclaimed" }
  /** We asked for this grid; it's ours. */
  | { kind: "owner" }
  /** Another viewer sized the PTY; we render its grid scaled to fit. */
  | { kind: "passive"; grid: Grid };

/** Resize requests we've sent that the daemon hasn't echoed yet (oldest first). */
export const MAX_PENDING_GRIDS = 32;

/** Record a grid we just asked the daemon for. */
export function pushSentGrid(sent: readonly Grid[], grid: Grid): Grid[] {
  const next = [...sent, grid];
  return next.length > MAX_PENDING_GRIDS ? next.slice(next.length - MAX_PENDING_GRIDS) : next;
}

/**
 * The daemon echoed `grid`: if it matches one of our pending requests, that
 * request and every older one are answered (echoes arrive in order). Returns
 * the remaining queue, or null when the echo matched nothing we sent.
 */
export function ackSentGrid(sent: readonly Grid[], grid: Grid): Grid[] | null {
  const i = sent.findIndex((g) => sameGrid(g, grid));
  return i < 0 ? null : sent.slice(i + 1);
}

/**
 * Next mode when the daemon announces the PTY grid. `natural` is what a fit
 * to our own screen would produce; `sent` the grids we've asked for that
 * haven't been echoed yet.
 *
 * Every echo of our own request is still ours — not just the latest. A
 * claim can fit twice in a few ms (the "sized for another device" strip
 * leaves, the pane grows, the observer refits), so the echo of the first
 * request lands after the second was sent. Treating that stale echo as
 * another viewer's grid pinned the pane to a grid taller than the pane and
 * hid its bottom rows.
 *
 * `recorded`: the terminal has exited and this is the grid its final screen
 * was drawn for. There is no PTY left to size, so the grid is pinned —
 * always passive, even when it happens to equal our natural fit — so a
 * window resize can never reflow the replayed screen into something else.
 */
export function onGridAnnounced(
  mode: SizingMode,
  grid: Grid,
  natural: Grid,
  sent: readonly Grid[],
  recorded = false,
): SizingMode {
  if (recorded) return { kind: "passive", grid };
  if (mode.kind === "owner") {
    // One of our own requests echoed back — still ours. Anything else means
    // another viewer took over since.
    return sent.some((g) => sameGrid(g, grid)) ? mode : { kind: "passive", grid };
  }
  // Unclaimed or already passive: if the announced grid happens to be our
  // natural fit there's nothing to scale, and no reason to show the banner.
  return sameGrid(grid, natural) ? { kind: "unclaimed" } : { kind: "passive", grid };
}
