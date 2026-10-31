/**
 * Linear in the ticket round trip (docs/ticket-round-trip.md, the Linear
 * section), over Linear's GraphQL API (`https://api.linear.app/graphql`, the
 * provider's API key in `Authorization`):
 *
 *   comments     `commentCreate`; an issue's `comments` (bots' left out)
 *   the link     a link attachment (`attachmentCreate`, which Linear updates in
 *                place for the same URL on the same issue); when the URL moves
 *                from the run to the merge request, the old one is removed
 *                (`attachmentDelete`)
 *   statuses     workflow states (`workflowStates`, the provider's team's when
 *                it names one); a move is `issueUpdate` with the state's id
 *   who am I     `viewer`
 *
 * Issues are looked up by their identifier (`issue(id: "ENG-123")`, which
 * Linear takes as well as a UUID).
 */
import type { TicketProviderConfig } from "@optio/shared";
import {
  atMentions,
  markdownCommentBody,
  sameName,
  serviceCall,
  TicketServiceError,
  type TicketCommentRecord,
  type TicketRoundTrip,
} from "./round-trip.js";

const ENDPOINT = "https://api.linear.app/graphql";
const SERVICE = "Linear";

interface LinearRoundTripConfig {
  apiKey: string;
  teamId?: string;
}

function asConfig(config: TicketProviderConfig): LinearRoundTripConfig {
  const c = config as Partial<LinearRoundTripConfig>;
  if (!c.apiKey) throw new Error("Linear provider requires apiKey in config");
  return c as LinearRoundTripConfig;
}

/** One GraphQL operation; Linear's first error message when it has errors. */
async function gql<T>(
  config: TicketProviderConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await serviceCall<{ data?: T; errors?: Array<{ message?: string }> }>(
    SERVICE,
    ENDPOINT,
    {
      method: "POST",
      headers: { Authorization: asConfig(config).apiKey },
      body: { query, variables },
    },
  );
  const errors = res.body?.errors;
  if (errors?.length) {
    throw new TicketServiceError(
      SERVICE,
      res.status,
      `Linear: ${String(errors[0]?.message ?? "the request failed").slice(0, 200)}`,
    );
  }
  if (!res.body?.data) throw new Error("Linear answered without data");
  return res.body.data;
}

interface LinearState {
  id: string;
  name: string;
  type?: string;
}

const ISSUE_STATE = `query OptioIssueState($id: String!) {
  issue(id: $id) { id state { id name type } team { id states(first: 250) { nodes { id name type } } } }
}`;

async function issueWithStates(ticketId: string, config: TicketProviderConfig) {
  const data = await gql<{
    issue: { id: string; state: LinearState | null; team: { states: { nodes: LinearState[] } } };
  }>(config, ISSUE_STATE, { id: ticketId });
  return data.issue;
}

async function issueUuid(ticketId: string, config: TicketProviderConfig): Promise<string> {
  const data = await gql<{ issue: { id: string } }>(
    config,
    `query OptioIssueId($id: String!) { issue(id: $id) { id } }`,
    { id: ticketId },
  );
  return data.issue.id;
}

export const linearRoundTrip: TicketRoundTrip = {
  source: "linear",
  capabilities: { links: true, statuses: true },

  normalizeTicketId: (input) => {
    const s = input.trim();
    const m =
      s.match(/^([A-Za-z][A-Za-z0-9]*-\d+)$/) ?? s.match(/\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/);
    return m ? m[1].toUpperCase() : null;
  },

  async whoAmI(config) {
    const { viewer } = await gql<{
      viewer: { id: string; name?: string; displayName?: string; email?: string };
    }>(config, `query OptioViewer { viewer { id name displayName email } }`);
    return {
      accountId: viewer.id,
      name: viewer.displayName ?? null,
      displayName: viewer.name ?? viewer.displayName ?? null,
      emailAddress: viewer.email ?? null,
    };
  },

  async listComments(ticketId, config, max = 50) {
    const data = await gql<{
      issue: {
        comments: {
          nodes: Array<{
            id: string;
            body: string;
            createdAt: string;
            user?: { id: string; name?: string; displayName?: string; email?: string } | null;
            botActor?: { id?: string; name?: string } | null;
          }>;
        };
      };
    }>(
      config,
      `query OptioIssueComments($id: String!) {
  issue(id: $id) { comments(first: 100) { nodes { id body createdAt user { id name displayName email } botActor { id name } } } }
}`,
      { id: ticketId },
    );
    return data.issue.comments.nodes
      .map((c): TicketCommentRecord => ({
        id: c.id,
        author: {
          accountId: c.user?.id ?? null,
          name: c.user?.displayName ?? null,
          displayName: c.user?.name ?? c.user?.displayName ?? c.botActor?.name ?? null,
          emailAddress: c.user?.email ?? null,
        },
        body: c.body ?? "",
        created: c.createdAt,
        bot: !!c.botActor || !c.user,
      }))
      .sort((a, b) => Date.parse(a.created) - Date.parse(b.created))
      .slice(-max);
  },

  async postComment(ticketId, parts, config) {
    const issueId = await issueUuid(ticketId, config);
    const data = await gql<{ commentCreate: { success: boolean; comment?: { id: string } } }>(
      config,
      `mutation OptioCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`,
      { input: { issueId, body: markdownCommentBody(parts) } },
    );
    if (!data.commentCreate.success) throw new Error("Linear didn't create the comment");
    return { id: data.commentCreate.comment?.id ?? null };
  },

  async upsertLink(ticketId, link, config) {
    const issueId = await issueUuid(ticketId, config);
    const data = await gql<{
      attachmentCreate: { success: boolean; attachment?: { id: string } };
    }>(
      config,
      `mutation OptioAttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success attachment { id } }
}`,
      {
        input: {
          issueId,
          url: link.url,
          title: link.title.slice(0, 255),
          ...(link.summary ? { subtitle: link.summary.slice(0, 255) } : {}),
          ...(link.iconUrl ? { iconUrl: link.iconUrl } : {}),
          metadata: { optio: link.globalId, resolved: !!link.resolved },
        },
      },
    );
    if (!data.attachmentCreate.success) throw new Error("Linear didn't create the attachment");
    const id = data.attachmentCreate.attachment?.id ?? null;
    if (link.previousId && id && link.previousId !== id) {
      // The link moved (run → merge request): the old attachment goes.
      const removed = await gql<{ attachmentDelete: { success: boolean } }>(
        config,
        `mutation OptioAttachmentDelete($id: String!) { attachmentDelete(id: $id) { success } }`,
        { id: link.previousId },
      ).catch((err) => {
        // Only an already deleted attachment is harmless. Authentication,
        // validation and rate-limit failures must remain retryable.
        if (err instanceof TicketServiceError && /^Linear: Entity not found\b/i.test(err.message)) {
          return { attachmentDelete: { success: true } };
        }
        throw err;
      });
      if (!removed.attachmentDelete.success)
        throw new Error("Linear didn't remove the old attachment");
    }
    return { id };
  },

  async statuses(config) {
    const teamId = asConfig(config).teamId;
    const data = await gql<{ workflowStates: { nodes: LinearState[] } }>(
      config,
      teamId
        ? `query OptioTeamStates($teamId: ID!) {
  workflowStates(first: 250, filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } }
}`
        : `query OptioStates { workflowStates(first: 250) { nodes { id name type } } }`,
      teamId ? { teamId } : {},
    );
    const seen = new Map<string, { name: string; category?: string }>();
    for (const s of data.workflowStates.nodes) {
      const key = s.name.trim().toLowerCase();
      if (s.name.trim() && !seen.has(key)) seen.set(key, { name: s.name.trim(), category: s.type });
    }
    return { statuses: [...seen.values()], scope: teamId ? "team" : "workspace" };
  },

  async issueStatus(ticketId, config) {
    const issue = await issueWithStates(ticketId, config);
    const status = issue.state?.name ?? null;
    return {
      status,
      current: status ? [status] : [],
      available: issue.team.states.nodes.map((s) => s.name).filter((n) => !sameName(n, status)),
    };
  },

  async moveToStatus(ticketId, status, config) {
    const issue = await issueWithStates(ticketId, config);
    const from = issue.state?.name ?? null;
    if (sameName(from, status)) return { moved: false, from, reason: "already" };
    const target = issue.team.states.nodes.find((s) => sameName(s.name, status));
    if (!target) {
      return {
        moved: false,
        from,
        reason: "unreachable",
        available: issue.team.states.nodes.map((s) => s.name).filter((n) => !sameName(n, from)),
      };
    }
    const data = await gql<{ issueUpdate: { success: boolean } }>(
      config,
      `mutation OptioIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`,
      { id: issue.id, input: { stateId: target.id } },
    );
    if (!data.issueUpdate.success) throw new Error("Linear didn't move the issue");
    return { moved: true, from };
  },

  /** `@displayName` (Linear's handle) or `@name`. */
  mentionsAccount: (body, account) =>
    atMentions(body, account?.name) || atMentions(body, account?.displayName),
};
