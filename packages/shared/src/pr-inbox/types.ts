import type { PrAgentLink, PrFacts, PrOptioReview, PrInboxStatus } from "./status.js";

/** One row of the pull-request panel. */
export interface PrInboxItem {
  facts: PrFacts;
  status: PrInboxStatus;
  repo: { id: string; fullName: string; repoUrl: string };
  agent: PrAgentLink | null;
  optioReview: PrOptioReview | null;
}

/** Where the viewer's handles came from. */
export type PrViewerSource = "linked" | "sign-in" | "none";

export interface PrInboxResponse {
  viewer: {
    handles: string[];
    source: PrViewerSource;
    /** A handle we could guess (the deployment token's account) when none is set. */
    suggestedHandle: string | null;
  };
  items: PrInboxItem[];
  /** Repositories that couldn't be read this time, with why. */
  errors: Array<{ repo: string; message: string }>;
  fetchedAt: string;
}

/** What "Send to agent" can ask an agent to do on a PR. */
export type PrAgentAction =
  "fix_ci" | "address_changes" | "resolve_conflicts" | "update_branch" | "reply";

export const PR_AGENT_ACTIONS: readonly PrAgentAction[] = [
  "fix_ci",
  "address_changes",
  "resolve_conflicts",
  "update_branch",
  "reply",
];
