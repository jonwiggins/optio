import { randomUUID } from "node:crypto";
import { fetchRoutedTo, startFakeHttp, type FakeHttp } from "./fake-http.js";

/**
 * An in-process Linear for tests of the ticket round trip on Linear
 * (@optio/ticket-providers linear-round-trip.ts): its GraphQL endpoint
 * answering the operations Optio sends (by operation name: OptioViewer,
 * OptioIssueId, OptioIssueComments, OptioCommentCreate,
 * OptioAttachmentCreate, OptioAttachmentDelete, OptioStates,
 * OptioTeamStates, OptioIssueState, OptioIssueUpdate), with the API key in
 * `Authorization`. Issues are looked up by identifier (`ENG-1`) or id, as
 * Linear does; `attachmentCreate` updates the attachment with the same URL
 * on the same issue, as Linear documents. Field names follow Linear's schema
 * (@linear/sdk's generated types); it is a stand-in, not Linear.
 *
 *   const linear = await startFakeLinear({ apiKey: "lin_api_1" });
 *   vi.stubGlobal("fetch", linear.fetch);   // https://api.linear.app → the fake
 *   linear.addIssue("ENG-1");
 *   // provider config → { apiKey: "lin_api_1", teamId: linear.teamId }
 */

export const LINEAR_API = "https://api.linear.app";

export interface FakeLinearUser {
  id: string;
  name: string;
  displayName: string;
  email: string;
  /** A guest of the workspace (only the teams they were invited to). */
  guest?: boolean;
}

export interface FakeLinearComment {
  id: string;
  body: string;
  createdAt: string;
  user: FakeLinearUser | null;
  botActor: { id: string; name: string } | null;
}

export interface FakeLinearAttachment {
  id: string;
  url: string;
  title: string;
  subtitle?: string;
  metadata?: Record<string, unknown>;
}

export interface FakeLinearIssue {
  id: string;
  identifier: string;
  stateId: string;
  comments: FakeLinearComment[];
  attachments: FakeLinearAttachment[];
}

export interface FakeLinear extends FakeHttp {
  fetch: typeof fetch;
  teamId: string;
  states: Array<{ id: string; name: string; type: string }>;
  bot: FakeLinearUser;
  person: FakeLinearUser;
  issues: Map<string, FakeLinearIssue>;
  addIssue(identifier: string, state?: string): FakeLinearIssue;
  /** A comment by `author` (default: a person), or by an integration when `author` is null. */
  comment(
    identifier: string,
    body: string,
    author?: FakeLinearUser | null,
    at?: Date,
  ): FakeLinearComment;
  stateOf(identifier: string): string;
}

export async function startFakeLinear(opts: { apiKey?: string } = {}): Promise<FakeLinear> {
  const apiKey = opts.apiKey ?? "fake-linear-key";
  const teamId = randomUUID();
  const states = [
    { id: randomUUID(), name: "Todo", type: "unstarted" },
    { id: randomUUID(), name: "In Progress", type: "started" },
    { id: randomUUID(), name: "In Review", type: "started" },
    { id: randomUUID(), name: "Done", type: "completed" },
    { id: randomUUID(), name: "Canceled", type: "canceled" },
  ];
  const bot: FakeLinearUser = {
    id: randomUUID(),
    name: "Optio Bot",
    displayName: "optio",
    email: "optio-bot@example.com",
  };
  const person: FakeLinearUser = {
    id: randomUUID(),
    name: "Ada Lovelace",
    displayName: "ada",
    email: "ada@example.com",
  };
  const issues = new Map<string, FakeLinearIssue>();

  const addIssue = (identifier: string, state = "Todo") => {
    const issue: FakeLinearIssue = {
      id: randomUUID(),
      identifier,
      stateId: states.find((s) => s.name === state)!.id,
      comments: [],
      attachments: [],
    };
    issues.set(identifier, issue);
    return issue;
  };
  const comment = (
    identifier: string,
    body: string,
    author: FakeLinearUser | null = person,
    at = new Date(),
  ) => {
    const issue = issues.get(identifier) ?? addIssue(identifier);
    const c: FakeLinearComment = {
      id: randomUUID(),
      body,
      createdAt: at.toISOString(),
      user: author,
      botActor: author ? null : { id: randomUUID(), name: "GitHub" },
    };
    issue.comments.push(c);
    return c;
  };
  const find = (id: unknown) =>
    [...issues.values()].find((i) => i.identifier === id || i.id === id) ?? null;
  const stateView = (id: string) => {
    const s = states.find((x) => x.id === id)!;
    return { id: s.id, name: s.name, type: s.type };
  };

  const http = await startFakeHttp(
    (call, reply) => {
      if (call.method !== "POST" || call.path !== "/graphql") {
        return reply(404, { errors: [{ message: "Not found" }] });
      }
      const query = String(call.body?.query ?? "");
      const v = (call.body?.variables ?? {}) as Record<string, any>;
      const op = query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1];
      const ok = (data: unknown) => reply(200, { data });
      const notFound = () =>
        reply(200, { data: null, errors: [{ message: "Entity not found: Issue" }] });
      switch (op) {
        case "OptioViewer":
          return ok({ viewer: bot });
        case "OptioIssueId": {
          const issue = find(v.id);
          return issue ? ok({ issue: { id: issue.id } }) : notFound();
        }
        case "OptioIssueComments": {
          const issue = find(v.id);
          return issue ? ok({ issue: { comments: { nodes: issue.comments } } }) : notFound();
        }
        case "OptioCommentCreate": {
          const issue = find(v.input?.issueId);
          if (!issue) return notFound();
          const c = comment(issue.identifier, String(v.input.body ?? ""), bot);
          return ok({ commentCreate: { success: true, comment: { id: c.id } } });
        }
        case "OptioAttachmentCreate": {
          const issue = find(v.input?.issueId);
          if (!issue) return notFound();
          const { url, title, subtitle, metadata } = v.input;
          let a = issue.attachments.find((x) => x.url === url);
          if (a) Object.assign(a, { title, subtitle, metadata });
          else {
            a = { id: randomUUID(), url, title, subtitle, metadata };
            issue.attachments.push(a);
          }
          return ok({ attachmentCreate: { success: true, attachment: { id: a.id } } });
        }
        case "OptioAttachmentDelete": {
          for (const issue of issues.values()) {
            const before = issue.attachments.length;
            issue.attachments = issue.attachments.filter((a) => a.id !== v.id);
            if (issue.attachments.length < before)
              return ok({ attachmentDelete: { success: true } });
          }
          return reply(200, { data: null, errors: [{ message: "Entity not found: Attachment" }] });
        }
        case "OptioStates":
          return ok({ workflowStates: { nodes: states.map((s) => stateView(s.id)) } });
        case "OptioTeamStates":
          return ok({
            workflowStates: {
              nodes: v.teamId === teamId ? states.map((s) => stateView(s.id)) : [],
            },
          });
        case "OptioIssueState": {
          const issue = find(v.id);
          if (!issue) return notFound();
          return ok({
            issue: {
              id: issue.id,
              state: stateView(issue.stateId),
              team: { id: teamId, states: { nodes: states.map((s) => stateView(s.id)) } },
            },
          });
        }
        case "OptioIssueUpdate": {
          const issue = find(v.id);
          if (!issue) return notFound();
          if (!states.some((s) => s.id === v.input?.stateId)) {
            return reply(200, { data: null, errors: [{ message: "Invalid state" }] });
          }
          issue.stateId = v.input.stateId;
          return ok({ issueUpdate: { success: true } });
        }
        default:
          return reply(400, { errors: [{ message: `No fake for operation ${op ?? "?"}` }] });
      }
    },
    (headers) => headers.authorization === apiKey,
  );

  return {
    ...http,
    fetch: fetchRoutedTo({ [LINEAR_API]: http.url }),
    teamId,
    states,
    bot,
    person,
    issues,
    addIssue,
    comment,
    stateOf: (identifier) => stateView(issues.get(identifier)!.stateId).name,
  };
}
