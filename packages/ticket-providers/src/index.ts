export type { TicketProvider } from "./types.js";
export { GitHubTicketProvider } from "./github.js";
export { GitLabTicketProvider } from "./gitlab.js";
export { LinearTicketProvider } from "./linear.js";
export { JiraTicketProvider, resolveJiraAuth, jiraConfigProblem } from "./jira.js";
export type {
  JiraProviderConfig,
  JiraDeployment,
  JiraAuthType,
  JiraConfigProblem,
} from "./jira.js";
export { NotionTicketProvider } from "./notion.js";
// The ticket round trip (docs/ticket-round-trip.md): one implementation per service.
export {
  ROUND_TRIP_CALL_TIMEOUT_MS,
  TicketServiceError,
  atMentions,
  linkCommentBody,
  markdownCommentBody,
  parseTicketTime,
  sameTicketAccount,
} from "./round-trip.js";
export type {
  CommentPart,
  TicketAccount,
  TicketCommentRecord,
  TicketIssueStatus,
  TicketLink,
  TicketMoveResult,
  TicketRoundTrip,
  TicketStatusList,
  TicketStatusOption,
} from "./round-trip.js";
export { githubRoundTrip } from "./github-round-trip.js";
export { gitlabRoundTrip, gitLabRoundTripConfig } from "./gitlab-round-trip.js";
export {
  jiraCommentBody,
  jiraIssueTransitions,
  jiraListComments,
  jiraMayInstruct,
  jiraMoveToStatus,
  jiraPostComment,
  jiraRoundTrip,
  jiraStatuses,
  jiraUpsertRemoteLink,
  jiraWhoAmI,
  parseJiraTime,
  sameJiraAccount,
} from "./jira-round-trip.js";
export type {
  JiraAccount,
  JiraCommentRecord,
  JiraIssueTransitions,
  JiraMoveResult,
  JiraRemoteLink,
  JiraStatus,
} from "./jira-round-trip.js";
export { linearRoundTrip } from "./linear-round-trip.js";
export { notionRichText, notionRoundTrip } from "./notion-round-trip.js";

import type { TicketProvider } from "./types.js";
import type { TicketSource } from "@optio/shared";
import { GitHubTicketProvider } from "./github.js";
import { GitLabTicketProvider } from "./gitlab.js";
import { LinearTicketProvider } from "./linear.js";
import { JiraTicketProvider } from "./jira.js";
import { NotionTicketProvider } from "./notion.js";

export function getTicketProvider(source: TicketSource): TicketProvider {
  switch (source) {
    case "github":
      return new GitHubTicketProvider();
    case "gitlab":
      return new GitLabTicketProvider();
    case "linear":
      return new LinearTicketProvider();
    case "jira":
      return new JiraTicketProvider();
    case "notion":
      return new NotionTicketProvider();
    default:
      throw new Error(`Unknown ticket source: ${source}`);
  }
}

import type { TicketRoundTrip } from "./round-trip.js";
import { githubRoundTrip } from "./github-round-trip.js";
import { gitlabRoundTrip } from "./gitlab-round-trip.js";
import { jiraRoundTrip } from "./jira-round-trip.js";
import { linearRoundTrip } from "./linear-round-trip.js";
import { notionRoundTrip } from "./notion-round-trip.js";

const ROUND_TRIPS: Record<string, TicketRoundTrip> = {
  github: githubRoundTrip,
  gitlab: gitlabRoundTrip,
  jira: jiraRoundTrip,
  linear: linearRoundTrip,
  notion: notionRoundTrip,
};

/** The round trip's calls for a ticket source, or null for one it doesn't work with. */
export function getTicketRoundTrip(source: string | null | undefined): TicketRoundTrip | null {
  return (source && ROUND_TRIPS[source]) || null;
}
