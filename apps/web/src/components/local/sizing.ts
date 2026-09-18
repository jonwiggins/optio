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

/**
 * Next mode when the daemon announces the PTY grid. `natural` is what a fit
 * to our own screen would produce; `lastSent` the grid we last asked for.
 */
export function onGridAnnounced(
  mode: SizingMode,
  grid: Grid,
  natural: Grid,
  lastSent: Grid | null,
): SizingMode {
  if (mode.kind === "owner") {
    // Our own request echoed back — still ours. Anything else means another
    // viewer took over since.
    return sameGrid(grid, lastSent) ? mode : { kind: "passive", grid };
  }
  // Unclaimed or already passive: if the announced grid happens to be our
  // natural fit there's nothing to scale, and no reason to show the banner.
  return sameGrid(grid, natural) ? { kind: "unclaimed" } : { kind: "passive", grid };
}
