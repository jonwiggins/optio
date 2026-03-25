export type { TicketProvider } from "./types.js";
export { GitHubTicketProvider } from "./github.js";
export { LinearTicketProvider } from "./linear.js";

import type { TicketProvider } from "./types.js";
import type { TicketSource } from "@optio/shared";
import { GitHubTicketProvider } from "./github.js";
import { LinearTicketProvider } from "./linear.js";

export function getTicketProvider(source: TicketSource): TicketProvider {
  switch (source) {
    case "github":
      return new GitHubTicketProvider();
    case "linear":
      return new LinearTicketProvider();
    default:
      throw new Error(`Unknown ticket source: ${source}`);
  }
}
