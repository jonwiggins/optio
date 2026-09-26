/**
 * Which screen a Local terminal's PTY is sized for: the one you're using.
 *
 * One PTY has one grid, and every viewer of a terminal is its owner on some
 * screen — a laptop tab, a second window, the phone. The server knows which
 * of them are attached, so it decides, instead of each viewer inferring it
 * from resize echoes:
 *
 * - A viewer reports how it sees the terminal (`view`): the grid that fits
 *   its screen, whether the terminal is on screen, and how long since its user
 *   touched it.
 * - When its user arrives (`open`: the pane opened, its tab came to the front,
 *   or they came back after a minute away) the PTY is fitted to that screen —
 *   unless the screen holding the grid is still in use: on screen, alive, and
 *   touched within LOCAL_VIEW_IN_USE_MS. The newcomer then renders the grid
 *   scaled to fit, with "Use this screen".
 * - A click, a keystroke, or "Use this screen" (`resize`) takes the grid
 *   outright.
 * - The holder's own screen changing size resizes the PTY with it.
 *
 * "Alive" is checked, not assumed: a laptop that went to sleep with the
 * session open keeps its socket for minutes. A holder that looks in use is
 * pinged before it keeps an arrival waiting; if it hasn't answered within
 * PROBE_TIMEOUT_MS it stops counting.
 *
 * Every `size` frame tells each viewer whether the grid is theirs (`yours`).
 * Viewers that never send `view` (older apps) count as on screen, count as
 * used when they type or resize, and take the grid only by resizing.
 */
import { LOCAL_VIEW_IN_USE_MS } from "@optio/shared";

export interface Grid {
  cols: number;
  rows: number;
}

export function sameGrid(a: Grid | null | undefined, b: Grid | null | undefined): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}

/** How long a ping may go unanswered before its viewer stops counting. */
export const PROBE_TIMEOUT_MS = 1_500;
/** A viewer heard from this recently is alive; no need to ping it. */
export const PROBE_FRESH_MS = 5_000;

/** A `view` frame, validated. */
export interface ViewReport extends Grid {
  visible: boolean;
  idleMs: number;
  open: boolean;
}

interface Viewer {
  /** The grid that fits its screen; null until it says (or resizes). */
  natural: Grid | null;
  /** The terminal is on its screen. */
  visible: boolean;
  /** When its user last touched it (ms); 0 = not yet. */
  usedAt: number;
  /** When it was last heard from — a frame or a pong (ms). */
  heardAt: number;
  /** A ping it hasn't answered yet: when it went out (ms). */
  pingSentAt: number | null;
  /** It let a ping go unanswered: a closed laptop, a suspended app. Cleared when it's heard from. */
  unresponsive: boolean;
}

export interface GridEffects<S> {
  /** Resize the PTY; the daemon's `size` echo comes back through `sized`. */
  resize(grid: Grid): void;
  /** Tell one viewer the PTY's grid and whether it's theirs. */
  announce(viewer: S, grid: Grid, yours: boolean): void;
  /** Ping one viewer; its pong comes back through `pong`. False when it can't be pinged. */
  ping(viewer: S): boolean;
}

/** The viewers of one terminal, and which of them the PTY is sized for. */
export class GridArbiter<S> {
  /** The PTY's grid, as the daemon last announced it. */
  private grid: Grid | null = null;
  /** The viewer the PTY is sized for. */
  private holder: S | null = null;
  private readonly viewers = new Map<S, Viewer>();
  /** A viewer that arrived while the holder looked in use, waiting on the holder's ping. */
  private waiting: S | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly fx: GridEffects<S>) {}

  get viewerCount(): number {
    return this.viewers.size;
  }

  has(viewer: S): boolean {
    return this.viewers.has(viewer);
  }

  holds(viewer: S): boolean {
    return this.holder === viewer;
  }

  add(viewer: S, now = Date.now()): void {
    if (this.viewers.has(viewer)) return;
    this.viewers.set(viewer, {
      natural: null,
      visible: true,
      usedAt: 0,
      heardAt: now,
      pingSentAt: null,
      unresponsive: false,
    });
  }

  /**
   * A viewer left. The grid stays as it is: the next screen to arrive, click,
   * or type takes it — including this one reconnecting after a blip.
   */
  remove(viewer: S): void {
    this.viewers.delete(viewer);
    if (this.waiting === viewer) this.waiting = null;
    if (this.holder === viewer) this.holder = null;
  }

  /** The daemon announced the PTY's grid. */
  sized(grid: Grid): void {
    this.grid = { cols: grid.cols, rows: grid.rows };
    this.announceAll();
  }

  /** A viewer reported how it sees the terminal. */
  view(viewer: S, report: ViewReport, now = Date.now()): void {
    const v = this.viewers.get(viewer);
    if (!v) return;
    this.heard(v, now);
    v.natural = { cols: report.cols, rows: report.rows };
    v.visible = report.visible;
    v.usedAt = Math.max(v.usedAt, now - Math.max(0, report.idleMs));
    if (this.holder === viewer) {
      // The holder's screen changed size: the PTY follows it.
      if (v.visible && !sameGrid(this.grid, v.natural)) this.fx.resize(v.natural);
      return;
    }
    if (report.open && report.visible) this.arrive(viewer, now);
  }

  /** Size the PTY to this viewer now: a click, a keystroke, "Use this screen". */
  claim(viewer: S, grid: Grid, now = Date.now()): void {
    const v = this.viewers.get(viewer);
    if (!v) return;
    this.heard(v, now);
    v.natural = { cols: grid.cols, rows: grid.rows };
    v.usedAt = now;
    this.holder = viewer;
    if (this.waiting === viewer) this.waiting = null;
    // Ask even for the grid the PTY already has: the echo tells every viewer
    // who holds it now.
    this.fx.resize(v.natural);
  }

  /** The viewer typed: it's in use. */
  input(viewer: S, now = Date.now()): void {
    const v = this.viewers.get(viewer);
    if (!v) return;
    this.heard(v, now);
    v.usedAt = now;
  }

  /** The viewer answered a ping. */
  pong(viewer: S, now = Date.now()): void {
    const v = this.viewers.get(viewer);
    if (v) this.heard(v, now);
  }

  dispose(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.waiting = null;
  }

  private heard(v: Viewer, now: number): void {
    v.heardAt = now;
    v.pingSentAt = null;
    v.unresponsive = false;
  }

  /** On screen, alive, and touched within LOCAL_VIEW_IN_USE_MS. */
  private inUse(v: Viewer | undefined, now: number): v is Viewer {
    return !!v && v.visible && !v.unresponsive && now - v.usedAt < LOCAL_VIEW_IN_USE_MS;
  }

  /** `viewer`'s user just arrived: fit the PTY to it unless the holder is still in use. */
  private arrive(viewer: S, now: number): void {
    const holder = this.holder === null ? undefined : this.viewers.get(this.holder);
    if (!this.inUse(holder, now)) {
      this.take(viewer);
      return;
    }
    // It looks in use. Heard from just now, it is; otherwise it may be a
    // laptop asleep with the session still open — ask it before deciding.
    if (now - holder.heardAt < PROBE_FRESH_MS) return;
    this.waiting = viewer;
    this.probe(this.holder as S, holder, now);
  }

  private take(viewer: S): void {
    const v = this.viewers.get(viewer);
    if (!v) return;
    this.holder = viewer;
    if (this.waiting === viewer) this.waiting = null;
    if (v.natural && !sameGrid(this.grid, v.natural)) this.fx.resize(v.natural);
    // The PTY already fits it: just say who holds it now.
    else this.announceAll();
  }

  private probe(viewer: S, v: Viewer, now: number): void {
    if (v.pingSentAt === null) {
      if (!this.fx.ping(viewer)) {
        v.unresponsive = true;
        this.settle(now);
        return;
      }
      v.pingSentAt = now;
    }
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => this.settle(Date.now()), PROBE_TIMEOUT_MS);
  }

  /** The ping window closed: whoever didn't answer stops counting, and the waiting viewer tries again. */
  private settle(now: number): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    for (const v of this.viewers.values()) {
      if (v.pingSentAt !== null && now - v.pingSentAt >= PROBE_TIMEOUT_MS) {
        v.pingSentAt = null;
        v.unresponsive = true;
      }
    }
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting !== null && this.viewers.has(waiting)) this.arrive(waiting, now);
  }

  private announceAll(): void {
    if (!this.grid) return;
    for (const viewer of this.viewers.keys()) {
      this.fx.announce(viewer, this.grid, viewer === this.holder);
    }
  }
}
