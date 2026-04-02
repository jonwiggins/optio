export type { TicketProvider } from "./types.js";
export { GitHubTicketProvider } from "./github.js";
export { GitLabTicketProvider } from "./gitlab.js";
export { LinearTicketProvider } from "./linear.js";
export { JiraTicketProvider } from "./jira.js";
export { NotionTicketProvider } from "./notion.js";

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
