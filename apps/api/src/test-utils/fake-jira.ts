import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process Jira Server / Data Center for tests of the round trip
 * (services/ticket-writeback.ts, ticket-follow-ups.ts, routes/ticket-round-trip.ts):
 * the REST v2 calls Optio makes, a personal access token, and issues kept in
 * memory with their comments, status and remote links.
 *
 *   const jira = await startFakeJira({ pat: "pat-1" });
 *   jira.addIssue("PLAT-1");
 *   jira.comment("PLAT-1", "please also add a test", jira.person);
 *   // provider config → { baseUrl: jira.url, deployment: "server", authType: "pat", apiToken: "pat-1" }
 *   jira.issues.get("PLAT-1").comments; jira.callsTo("POST /rest/api/2/issue/PLAT-1/remotelink")
 *   jira.failNext("POST /rest/api/2/issue/PLAT-1/comment", 503);
 *   await jira.close();
 *
 * Statuses: To Do, In Progress, In Review, Done; every one is reachable from
 * every other, as in Jira's default "simplified" workflow.
 */

export interface FakeJiraAccount {
  name: string;
  key: string;
  displayName: string;
  emailAddress: string;
}

export interface FakeJiraComment {
  id: string;
  author: FakeJiraAccount;
  body: string;
  created: string;
}

export interface FakeRemoteLink {
  id: number;
  globalId?: string;
  application?: unknown;
  relationship?: string;
  object: { url: string; title: string; summary?: string; status?: { resolved?: boolean } };
}

export interface FakeJiraIssue {
  key: string;
  status: string;
  comments: FakeJiraComment[];
  remoteLinks: FakeRemoteLink[];
}

export interface FakeJiraCall {
  method: string;
  path: string;
  body: unknown;
}

export const FAKE_JIRA_STATUSES = ["To Do", "In Progress", "In Review", "Done"];

export interface FakeJira {
  url: string;
  bot: FakeJiraAccount;
  person: FakeJiraAccount;
  issues: Map<string, FakeJiraIssue>;
  calls: FakeJiraCall[];
  addIssue(key: string, status?: string): FakeJiraIssue;
  /** A comment as `author` (default: a person), written at `at` (default: now). */
  comment(key: string, body: string, author?: FakeJiraAccount, at?: Date): FakeJiraComment;
  callsTo(route: string): FakeJiraCall[];
  /** The next call to `route` answers `status` (once). */
  failNext(route: string, status: number): void;
  close(): Promise<void>;
}

/** Jira's own timestamp format: `2026-10-24T10:00:00.000+0000`. */
const jiraTime = (d: Date) => d.toISOString().replace("Z", "+0000");

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function startFakeJira(opts: { pat?: string } = {}): Promise<FakeJira> {
  const pat = opts.pat ?? "fake-jira-pat";
  const bot: FakeJiraAccount = {
    name: "optio-bot",
    key: "JIRAUSER10000",
    displayName: "Optio Bot",
    emailAddress: "optio-bot@example.test",
  };
  const person: FakeJiraAccount = {
    name: "ada",
    key: "JIRAUSER10001",
    displayName: "Ada Lovelace",
    emailAddress: "ada@example.test",
  };
  const issues = new Map<string, FakeJiraIssue>();
  const calls: FakeJiraCall[] = [];
  const failures = new Map<string, number>();
  let commentSeq = 30000;
  let linkSeq = 0;

  const addIssue = (key: string, status = "To Do") => {
    const issue: FakeJiraIssue = { key, status, comments: [], remoteLinks: [] };
    issues.set(key, issue);
    return issue;
  };
  const comment = (key: string, body: string, author = person, at = new Date()) => {
    const issue = issues.get(key) ?? addIssue(key);
    const c: FakeJiraComment = { id: String(++commentSeq), author, body, created: jiraTime(at) };
    issue.comments.push(c);
    return c;
  };
  const statusView = (name: string) => ({
    name,
    statusCategory: { name: name === "Done" ? "Done" : name === "To Do" ? "To Do" : "In Progress" },
  });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-jira");
    const path = url.pathname.replace(/\/+$/, "");
    const body = req.method === "GET" ? null : await bodyOf(req);
    const route = `${req.method} ${path}`;
    calls.push({ method: req.method ?? "", path, body });
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${pat}`) {
      return send(401, { errorMessages: ["You are not authenticated."] });
    }
    const failure = failures.get(route);
    if (failure) {
      failures.delete(route);
      return send(failure, { errorMessages: ["injected failure"] });
    }
    if (route === "GET /rest/api/2/myself") return send(200, bot);
    if (route === "GET /rest/api/2/status") return send(200, FAKE_JIRA_STATUSES.map(statusView));
    let m = path.match(/^\/rest\/api\/2\/project\/([^/]+)\/statuses$/);
    if (m && req.method === "GET") {
      return send(200, [
        { name: "Task", statuses: FAKE_JIRA_STATUSES.map(statusView) },
        { name: "Bug", statuses: FAKE_JIRA_STATUSES.slice(0, 2).map(statusView) },
      ]);
    }
    m = path.match(/^\/rest\/api\/2\/issue\/([^/]+)(?:\/(comment|transitions|remotelink))?$/);
    if (!m) return send(404, { errorMessages: [`No fake for ${route}`] });
    const issue = issues.get(m[1]);
    if (!issue) return send(404, { errorMessages: ["Issue does not exist"] });
    const what = m[2];
    const b = (body ?? {}) as Record<string, any>;
    if (!what && req.method === "GET") {
      return send(200, { key: issue.key, fields: { status: statusView(issue.status) } });
    }
    if (what === "comment" && req.method === "GET") {
      const list = [...issue.comments];
      if ((url.searchParams.get("orderBy") ?? "").startsWith("-")) list.reverse();
      return send(200, { startAt: 0, total: list.length, comments: list });
    }
    if (what === "comment" && req.method === "POST") {
      return send(201, comment(issue.key, String(b.body ?? ""), bot));
    }
    if (what === "transitions" && req.method === "GET") {
      return send(200, {
        transitions: FAKE_JIRA_STATUSES.filter((s) => s !== issue.status).map((s) => ({
          id: String(11 + FAKE_JIRA_STATUSES.indexOf(s) * 10),
          name: `Move to ${s}`,
          to: statusView(s),
        })),
      });
    }
    if (what === "transitions" && req.method === "POST") {
      const id = Number(b.transition?.id);
      const target = FAKE_JIRA_STATUSES[(id - 11) / 10];
      if (!target || target === issue.status)
        return send(400, { errorMessages: ["No such transition"] });
      issue.status = target;
      return send(204);
    }
    if (what === "remotelink" && req.method === "GET") return send(200, issue.remoteLinks);
    if (what === "remotelink" && req.method === "POST") {
      const existing = b.globalId
        ? issue.remoteLinks.find((l) => l.globalId === b.globalId)
        : undefined;
      if (existing) {
        Object.assign(existing, {
          application: b.application,
          relationship: b.relationship,
          object: b.object,
        });
        return send(200, {
          id: existing.id,
          self: `/rest/api/2/issue/${issue.key}/remotelink/${existing.id}`,
        });
      }
      const link: FakeRemoteLink = {
        id: ++linkSeq,
        globalId: b.globalId,
        application: b.application,
        relationship: b.relationship,
        object: b.object,
      };
      issue.remoteLinks.push(link);
      return send(201, {
        id: link.id,
        self: `/rest/api/2/issue/${issue.key}/remotelink/${link.id}`,
      });
    }
    return send(404, { errorMessages: [`No fake for ${route}`] });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    bot,
    person,
    issues,
    calls,
    addIssue,
    comment,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    failNext: (route, status) => void failures.set(route, status),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
