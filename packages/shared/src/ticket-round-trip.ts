/**
 * The ticket round trip's settings on one ticket provider
 * (docs/ticket-round-trip.md): whether Optio writes back on a ticket its work
 * came from, what it writes, and whether a person's comment there resumes
 * the work. Kept on the provider row as `config.roundTrip` (no credentials
 * in it), saved from Settings → Integrations → Tickets
 * (`PUT /api/tickets/providers/:id/round-trip`) and read by
 * apps/api/src/services/ticket-writeback.ts and ticket-follow-ups.ts.
 *
 * Off until someone who may change the provider turns it on (`enabled`): a
 * provider without these settings behaves as before the round trip existed.
 */

/** Which comments on the ticket resume its work. */
export type TicketFollowUpMode = "any" | "mention" | "off";

export const TICKET_FOLLOW_UP_MODES: readonly TicketFollowUpMode[] = ["any", "mention", "off"];

/** The moments a ticket can be moved to another status. */
export type RoundTripStep = "started" | "mrOpened" | "merged" | "failed";

export const ROUND_TRIP_STEPS: readonly RoundTripStep[] = [
  "started",
  "mrOpened",
  "merged",
  "failed",
];

export const ROUND_TRIP_STEP_LABELS: Record<RoundTripStep, string> = {
  started: "Work started",
  mrOpened: "Merge request opened",
  merged: "Merged",
  failed: "Failed",
};

export interface TicketRoundTripSettings {
  /** Whether the round trip runs for this provider at all (off by default). */
  enabled: boolean;
  /** Comments at start (a link to the run), MR opened, merged, failed or waiting for a person. */
  comments: boolean;
  /**
   * One link per piece of work on the ticket, to the run and then the merge
   * request, kept up to date (how depends on the provider: ROUND_TRIP_SUPPORT).
   */
  remoteLink: boolean;
  /**
   * `any`: a new comment by a person (not the provider's own account)
   * resumes work that waits or has its MR open; `mention`: only one that
   * starts with `/optio` or mentions `@optio` (or the account); `off`: none.
   */
  followUps: TicketFollowUpMode;
  /** The status to move the ticket to at each step; "" leaves it where it is. */
  transitions: Record<RoundTripStep, string>;
}

export const DEFAULT_ROUND_TRIP: TicketRoundTripSettings = {
  enabled: false,
  comments: true,
  remoteLink: true,
  followUps: "any",
  transitions: { started: "", mrOpened: "", merged: "", failed: "" },
};

/** The ticket sources the round trip works with, alphabetically. */
export type RoundTripSource = "github" | "gitlab" | "jira" | "linear" | "notion";

export const ROUND_TRIP_SOURCES: readonly RoundTripSource[] = [
  "github",
  "gitlab",
  "jira",
  "linear",
  "notion",
];

/** What the round trip can do with one source's tickets, for the API and the settings form. */
export interface RoundTripSupport {
  /** The service's name. */
  name: string;
  /** What one of its tickets is called: `the Jira ticket PLAT-1`, `the GitHub issue 12`. */
  noun: string;
  /**
   * How the work's link is kept on the ticket, or null without one:
   * `remote-link` (a link Jira updates in place), `comment` (one comment by
   * Optio, edited as the work goes), `attachment` (a link attachment).
   */
  link: "remote-link" | "comment" | "attachment" | null;
  /** Whether a step can move the ticket to a status. */
  statuses: boolean;
  /** What the statuses to pick from are. */
  statusHelp: string;
  /** A ticket id to show in the Test field. */
  example: string;
  /**
   * Whether a ticket id names one ticket across the service (a Jira key, a
   * Linear identifier, a Notion page id) rather than only within a repository
   * (a GitHub or GitLab issue number). Only then may work that doesn't say
   * which provider its ticket came through be matched to one by its owner.
   */
  uniqueIds: boolean;
}

export const ROUND_TRIP_SUPPORT: Record<RoundTripSource, RoundTripSupport> = {
  github: {
    name: "GitHub",
    noun: "GitHub issue",
    link: "comment",
    statuses: true,
    statusHelp:
      "Open or Closed, or one of the repository's labels (moving to a label takes off the labels of the other steps).",
    example: "12",
    uniqueIds: false,
  },
  gitlab: {
    name: "GitLab",
    noun: "GitLab issue",
    link: "comment",
    statuses: true,
    statusHelp:
      "Open or Closed, or one of the project's labels (moving to a label takes off the labels of the other steps).",
    example: "12",
    uniqueIds: false,
  },
  jira: {
    name: "Jira",
    noun: "Jira ticket",
    link: "remote-link",
    statuses: true,
    statusHelp:
      "The project's statuses (every status on the server when the provider names no project); a move takes whichever transition leads there.",
    example: "PLAT-1",
    uniqueIds: true,
  },
  linear: {
    name: "Linear",
    noun: "Linear issue",
    link: "attachment",
    statuses: true,
    statusHelp: "The team's workflow states (every team's when the provider names no team).",
    example: "ENG-1",
    uniqueIds: true,
  },
  notion: {
    name: "Notion",
    noun: "Notion page",
    link: null,
    statuses: true,
    statusHelp: "The options of the database's status property.",
    example: "a page id or link",
    uniqueIds: true,
  },
};

/** What the round trip can do for a source, or null when it has no round trip. */
export function roundTripSupport(source: string | null | undefined): RoundTripSupport | null {
  return source && (ROUND_TRIP_SOURCES as readonly string[]).includes(source)
    ? ROUND_TRIP_SUPPORT[source as RoundTripSource]
    : null;
}

/** Whether the round trip runs for a provider: a source it works with, and switched on. */
export function roundTripActive(provider: { source: string; config: unknown }): boolean {
  return !!roundTripSupport(provider.source) && roundTripSettings(provider.config).enabled;
}

const STATUS_MAX = 120;

/** A status name as stored: trimmed, one line, at most 120 characters. */
function statusName(v: unknown): string {
  return typeof v === "string"
    ? v
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, STATUS_MAX)
    : "";
}

/** The settings a provider's stored config means, defaults filled in. Never throws. */
export function roundTripSettings(config: unknown): TicketRoundTripSettings {
  const raw =
    config && typeof config === "object"
      ? ((config as Record<string, unknown>).roundTrip as Record<string, unknown> | undefined)
      : undefined;
  return normalizeRoundTrip(raw);
}

/** Settings from a request body or a stored value: unknown keys dropped, defaults filled in. */
export function normalizeRoundTrip(raw: unknown): TicketRoundTripSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const t =
    r.transitions && typeof r.transitions === "object"
      ? (r.transitions as Record<string, unknown>)
      : {};
  const followUps = TICKET_FOLLOW_UP_MODES.includes(r.followUps as TicketFollowUpMode)
    ? (r.followUps as TicketFollowUpMode)
    : DEFAULT_ROUND_TRIP.followUps;
  return {
    enabled: r.enabled === true,
    comments: typeof r.comments === "boolean" ? r.comments : DEFAULT_ROUND_TRIP.comments,
    remoteLink: typeof r.remoteLink === "boolean" ? r.remoteLink : DEFAULT_ROUND_TRIP.remoteLink,
    followUps,
    transitions: {
      started: statusName(t.started),
      mrOpened: statusName(t.mrOpened),
      merged: statusName(t.merged),
      failed: statusName(t.failed),
    },
  };
}
