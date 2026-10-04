/**
 * Where work runs, for the Machines page: the Work feed (`GET /api/work`)
 * sorted into each paired machine (by `where.hostId`) and the Optio pods
 * (grouped by repo, Jobs, and persistent agents). Pure, so it is tested on
 * its own (`work-places.test.ts`).
 */
import { inView, sortWork, type WorkRow } from "./work-feed";

/** The work at one place: what is live now, and what is set up to run there. */
export interface PlaceWork {
  /** Running, queued, waiting, or needing you. */
  now: WorkRow[];
  /** Recurring definitions (automations, Jobs, scheduled Tasks) and standing agents. */
  setUp: WorkRow[];
}

export interface PodGroup {
  /** Stable key: `repo:<owner/name>`, `jobs`, `agents`, or `other`. */
  key: string;
  kind: "repo" | "jobs" | "agents" | "other";
  /** "acme/app", "Jobs", "Persistent agents", "Other". */
  label: string;
  work: PlaceWork;
}

export interface WorkPlaces {
  /** Per paired machine id. Every id passed in has an entry, empty or not. */
  machines: Record<string, PlaceWork>;
  /** Machine work whose machine isn't one of the caller's (or has none set). */
  otherMachines: PlaceWork;
  /** Pod work: repos first (busiest first, then by name), then Jobs, agents, other. */
  pods: PodGroup[];
}

const empty = (): PlaceWork => ({ now: [], setUp: [] });

/**
 * Which half of a place a row belongs in, or null when it is history: a
 * persistent agent that isn't archived is standing work even while idle.
 */
function bucket(row: WorkRow): keyof PlaceWork | null {
  if (inView(row, "active")) return "now";
  if (row.recurring) return "setUp";
  if (row.source === "persistent-agent" && row.status !== "done") return "setUp";
  return null;
}

function podGroupOf(row: WorkRow): Pick<PodGroup, "key" | "kind" | "label"> {
  if (row.source === "persistent-agent") {
    return { key: "agents", kind: "agents", label: "Persistent agents" };
  }
  if (row.source === "standalone") return { key: "jobs", kind: "jobs", label: "Jobs" };
  // Repo Tasks, scheduled Tasks and pod sessions are named by their repo.
  if (row.where.detail) {
    return { key: `repo:${row.where.detail}`, kind: "repo", label: row.where.detail };
  }
  return { key: "other", kind: "other", label: "Other" };
}

const KIND_ORDER: Record<PodGroup["kind"], number> = { repo: 0, jobs: 1, agents: 2, other: 3 };

export function groupWorkByPlace(rows: WorkRow[], hostIds: string[]): WorkPlaces {
  const machines: Record<string, PlaceWork> = Object.fromEntries(
    hostIds.map((id) => [id, empty()]),
  );
  const otherMachines = empty();
  const pods = new Map<string, PodGroup>();

  for (const row of sortWork(rows)) {
    const half = bucket(row);
    if (!half) continue;
    if (row.where.target === "machine") {
      const place = (row.where.hostId && machines[row.where.hostId]) || otherMachines;
      place[half].push(row);
      continue;
    }
    const g = podGroupOf(row);
    let group = pods.get(g.key);
    if (!group) {
      group = { ...g, work: empty() };
      pods.set(g.key, group);
    }
    group.work[half].push(row);
  }

  // Within a place, what waits on you leads (the feed's order otherwise).
  const needsYouFirst = (w: PlaceWork) => {
    w.now = [
      ...w.now.filter((r) => r.status === "needs_you"),
      ...w.now.filter((r) => r.status !== "needs_you"),
    ];
  };
  Object.values(machines).forEach(needsYouFirst);
  needsYouFirst(otherMachines);
  pods.forEach((g) => needsYouFirst(g.work));

  return {
    machines,
    otherMachines,
    pods: [...pods.values()].sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        b.work.now.length - a.work.now.length ||
        a.label.localeCompare(b.label),
    ),
  };
}

/** How many rows a place holds. */
export const placeSize = (w: PlaceWork) => w.now.length + w.setUp.length;

/** "2 running · 1 needs you" style summary of what is live at a place. */
export function nowSummary(w: PlaceWork): string | null {
  const needsYou = w.now.filter((r) => r.status === "needs_you").length;
  const live = w.now.length - needsYou;
  const parts = [
    needsYou ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : null,
    live ? `${live} active` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
