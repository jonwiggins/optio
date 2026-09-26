import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_VIEW_IN_USE_MS } from "@optio/shared";
import { GridArbiter, PROBE_FRESH_MS, PROBE_TIMEOUT_MS, type Grid } from "./local-grid.js";

type Viewer = "laptop" | "phone" | "tab";

/** An arbiter whose effects are recorded; `echo` plays the daemon answering each resize. */
function setup(opts: { echo?: boolean; pingable?: boolean } = {}) {
  const resizes: Grid[] = [];
  const announced: Array<{ viewer: Viewer; grid: Grid; yours: boolean }> = [];
  const pinged: Viewer[] = [];
  const arbiter: GridArbiter<Viewer> = new GridArbiter<Viewer>({
    resize: (grid) => {
      resizes.push(grid);
      if (opts.echo !== false) arbiter.sized(grid);
    },
    announce: (viewer, grid, yours) => announced.push({ viewer, grid, yours }),
    ping: (viewer) => {
      pinged.push(viewer);
      return opts.pingable !== false;
    },
  });
  /** What `viewer` was last told: its grid and whether it's theirs. */
  const last = (viewer: Viewer) => announced.filter((a) => a.viewer === viewer).at(-1);
  return { arbiter, resizes, announced, pinged, last };
}

const LAPTOP: Grid = { cols: 160, rows: 45 };
const PHONE: Grid = { cols: 48, rows: 30 };

const open = (grid: Grid, idleMs = 0) => ({ ...grid, visible: true, idleMs, open: true });
const report = (grid: Grid, visible = true, idleMs = 0) => ({
  ...grid,
  visible,
  idleMs,
  open: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("GridArbiter", () => {
  it("fits the PTY to the first screen that opens the terminal", () => {
    const { arbiter, resizes, last } = setup();
    arbiter.sized({ cols: 120, rows: 32 }); // the spawn size
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    expect(resizes).toEqual([LAPTOP]);
    expect(last("laptop")).toEqual({ viewer: "laptop", grid: LAPTOP, yours: true });
  });

  it("leaves the grid with a screen in use: the newcomer watches it scaled", () => {
    const { arbiter, resizes, last } = setup();
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    arbiter.add("phone");
    arbiter.view("phone", open(PHONE));
    expect(resizes).toEqual([LAPTOP]);
    arbiter.sized(LAPTOP); // the daemon's announce for the phone's attach
    expect(last("phone")).toEqual({ viewer: "phone", grid: LAPTOP, yours: false });
    expect(last("laptop")?.yours).toBe(true);
  });

  it("moves the grid to the newcomer once the holder has sat untouched for a minute", () => {
    const { arbiter, resizes, last } = setup();
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    vi.advanceTimersByTime(LOCAL_VIEW_IN_USE_MS);
    arbiter.add("phone");
    arbiter.view("phone", open(PHONE));
    expect(resizes).toEqual([LAPTOP, PHONE]);
    expect(last("phone")?.yours).toBe(true);
    expect(last("laptop")).toEqual({ viewer: "laptop", grid: PHONE, yours: false });
  });

  it("does not count a holder whose terminal is off screen", () => {
    const { arbiter, resizes } = setup();
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    arbiter.view("laptop", report(LAPTOP, false)); // its tab went to the background
    arbiter.add("phone");
    arbiter.view("phone", open(PHONE));
    expect(resizes).toEqual([LAPTOP, PHONE]);
  });

  it("asks a quiet holder whether it is still there before keeping the newcomer waiting", () => {
    const { arbiter, resizes, pinged } = setup();
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    // The lid closes 10 s later: the socket stays open, the laptop never answers.
    vi.advanceTimersByTime(PROBE_FRESH_MS + 5_000);
    arbiter.add("phone");
    arbiter.view("phone", open(PHONE));
    expect(pinged).toEqual(["laptop"]);
    expect(resizes).toEqual([LAPTOP]);
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    expect(resizes).toEqual([LAPTOP, PHONE]);
    expect(arbiter.holds("phone")).toBe(true);
  });

  it("keeps the grid with a holder that answers the ping", () => {
    const { arbiter, resizes, pinged } = setup();
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    vi.advanceTimersByTime(PROBE_FRESH_MS + 5_000);
    arbiter.add("phone");
    arbiter.view("phone", open(PHONE));
    arbiter.pong("laptop");
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    expect(pinged).toEqual(["laptop"]);
    expect(resizes).toEqual([LAPTOP]);
    expect(arbiter.holds("laptop")).toBe(true);
  });

  it("does not ping a holder heard from moments ago", () => {
    const { arbiter, pinged } = setup();
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    vi.advanceTimersByTime(PROBE_FRESH_MS + 5_000);
    arbiter.input("laptop"); // typing
    arbiter.add("phone");
    arbiter.view("phone", open(PHONE));
    expect(pinged).toEqual([]);
    expect(arbiter.holds("laptop")).toBe(true);
  });

  it("hands the grid over straight away when the holder can't be pinged", () => {
    const { arbiter, resizes } = setup({ pingable: false });
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    vi.advanceTimersByTime(PROBE_FRESH_MS + 5_000);
    arbiter.add("phone");
    arbiter.view("phone", open(PHONE));
    expect(resizes).toEqual([LAPTOP, PHONE]);
  });

  it("drops a waiting newcomer that leaves before the ping settles", () => {
    const { arbiter, resizes } = setup();
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    vi.advanceTimersByTime(PROBE_FRESH_MS + 5_000);
    arbiter.add("phone");
    arbiter.view("phone", open(PHONE));
    arbiter.remove("phone");
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    expect(resizes).toEqual([LAPTOP]);
  });

  it("follows the holder's screen as it changes size, and nobody else's", () => {
    const { arbiter, resizes } = setup();
    arbiter.add("laptop");
    arbiter.add("phone");
    arbiter.view("laptop", open(LAPTOP));
    arbiter.view("phone", open(PHONE));
    arbiter.view("phone", report({ cols: 30, rows: 50 })); // rotated
    arbiter.view("laptop", report({ cols: 100, rows: 45 })); // window narrowed
    expect(resizes).toEqual([LAPTOP, { cols: 100, rows: 45 }]);
  });

  it("gives the grid to a click or keystroke outright, re-asserting even an unchanged grid", () => {
    const { arbiter, resizes, last } = setup();
    arbiter.add("laptop");
    arbiter.add("phone");
    arbiter.view("laptop", open(LAPTOP));
    arbiter.view("phone", open(PHONE)); // waits: the laptop is in use
    arbiter.claim("phone", PHONE); // "Use this screen"
    arbiter.claim("phone", PHONE);
    expect(resizes).toEqual([LAPTOP, PHONE, PHONE]);
    expect(last("laptop")).toEqual({ viewer: "laptop", grid: PHONE, yours: false });
    expect(last("phone")?.yours).toBe(true);
  });

  it("only announces when the newcomer's screen already fits the PTY", () => {
    const { arbiter, resizes, last } = setup();
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    arbiter.add("tab"); // the same laptop, a second tab
    vi.advanceTimersByTime(LOCAL_VIEW_IN_USE_MS);
    arbiter.view("tab", open(LAPTOP));
    expect(resizes).toEqual([LAPTOP]);
    expect(last("tab")).toEqual({ viewer: "tab", grid: LAPTOP, yours: true });
    expect(last("laptop")).toEqual({ viewer: "laptop", grid: LAPTOP, yours: false });
  });

  it("takes nothing for a screen that isn't showing the terminal", () => {
    const { arbiter, resizes } = setup();
    arbiter.add("laptop");
    arbiter.view("laptop", { ...LAPTOP, visible: false, idleMs: 0, open: true });
    arbiter.view("laptop", report(LAPTOP)); // on screen, but not an arrival
    expect(resizes).toEqual([]);
  });

  it("counts an older client (no view frames) as in use while it types", () => {
    const { arbiter, resizes } = setup();
    arbiter.add("phone");
    arbiter.claim("phone", PHONE);
    arbiter.add("laptop");
    arbiter.input("phone");
    arbiter.view("laptop", open(LAPTOP));
    expect(resizes).toEqual([PHONE]);
    vi.advanceTimersByTime(LOCAL_VIEW_IN_USE_MS);
    arbiter.view("laptop", open(LAPTOP));
    expect(resizes).toEqual([PHONE, LAPTOP]);
  });

  it("measures use from the reported idle time, so a reconnect after a nap doesn't count", () => {
    const { arbiter, resizes } = setup();
    arbiter.add("laptop");
    arbiter.claim("laptop", LAPTOP);
    arbiter.remove("laptop"); // a blip
    arbiter.add("laptop");
    arbiter.view("laptop", report(LAPTOP, true, 10 * 60_000)); // back, untouched for 10 min
    arbiter.add("phone");
    arbiter.view("phone", open(PHONE));
    expect(resizes).toEqual([LAPTOP, PHONE]);
  });

  it("frees the grid when its holder leaves; the next arrival takes it", () => {
    const { arbiter, resizes } = setup();
    arbiter.add("laptop");
    arbiter.add("phone");
    arbiter.view("laptop", open(LAPTOP));
    arbiter.view("phone", open(PHONE));
    arbiter.remove("laptop");
    expect(resizes).toEqual([LAPTOP]); // no hand-over by itself
    arbiter.view("phone", open(PHONE));
    expect(resizes).toEqual([LAPTOP, PHONE]);
  });

  it("counts a viewer that missed a ping again once it's heard from", () => {
    const { arbiter, resizes } = setup();
    arbiter.add("laptop");
    arbiter.view("laptop", open(LAPTOP));
    vi.advanceTimersByTime(PROBE_FRESH_MS + 5_000);
    arbiter.add("phone");
    arbiter.view("phone", open(PHONE));
    vi.advanceTimersByTime(PROBE_TIMEOUT_MS); // the phone takes it
    // The laptop wakes, is used, and the phone's user comes back to it a minute later.
    arbiter.claim("laptop", LAPTOP);
    arbiter.view("phone", open(PHONE));
    expect(resizes).toEqual([LAPTOP, PHONE, LAPTOP]);
    expect(arbiter.holds("laptop")).toBe(true);
  });
});
