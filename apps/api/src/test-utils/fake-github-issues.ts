import { fetchRoutedTo, pageOf, startFakeHttp, type FakeHttp } from "./fake-http.js";

/**
 * An in-process GitHub for tests of the ticket round trip on GitHub Issues
 * (@optio/ticket-providers github-round-trip.ts): the REST calls Optio makes
 * on one repository, `acme/app`, with a bearer token, and issues kept in
 * memory with their state, labels and comments. Shaped after GitHub's REST
 * reference (issues, issue comments, labels, the authenticated user); it is
 * a stand-in, not GitHub.
 *
 *   const gh = await startFakeGitHubIssues({ token: "ghp-1" });
 *   vi.stubGlobal("fetch", gh.fetch);       // https://api.github.com → the fake
 *   gh.addIssue(12);
 *   gh.comment(12, "please also add a test", gh.person);
 *   // provider config → { token: "ghp-1", owner: "acme", repo: "app" }
 */

export const GITHUB_API = "https://api.github.com";

export interface FakeGitHubUser {
  id: number;
  login: string;
  type: "User" | "Bot";
  /** How they relate to acme/app (a comment's `author_association`); default COLLABORATOR. */
  association?: "OWNER" | "MEMBER" | "COLLABORATOR" | "CONTRIBUTOR" | "NONE";
}

export interface FakeGitHubComment {
  id: number;
  user: FakeGitHubUser;
  body: string;
  created_at: string;
  updated_at: string;
  performed_via_github_app: null | { id: number; slug: string };
  author_association: string;
}

export interface FakeGitHubIssue {
  number: number;
  state: "open" | "closed";
  state_reason: string | null;
  labels: string[];
  comments: FakeGitHubComment[];
}

export interface FakeGitHubIssues extends FakeHttp {
  fetch: typeof fetch;
  bot: FakeGitHubUser;
  person: FakeGitHubUser;
  /** Someone who may comment on the public repository but not push to it. */
  stranger: FakeGitHubUser;
  app: FakeGitHubUser;
  /** The repository's labels. */
  labels: string[];
  issues: Map<number, FakeGitHubIssue>;
  addIssue(n: number, state?: "open" | "closed", labels?: string[]): FakeGitHubIssue;
  comment(n: number, body: string, author?: FakeGitHubUser, at?: Date): FakeGitHubComment;
}

export async function startFakeGitHubIssues(
  opts: { token?: string; labels?: string[]; installation?: boolean } = {},
): Promise<FakeGitHubIssues> {
  const token = opts.token ?? "fake-github-token";
  const bot: FakeGitHubUser = {
    id: 9001,
    login: "optio-bot",
    type: opts.installation ? "Bot" : "User",
  };
  const person: FakeGitHubUser = { id: 1001, login: "ada", type: "User" };
  const stranger: FakeGitHubUser = {
    id: 1002,
    login: "mallory",
    type: "User",
    association: "NONE",
  };
  const app: FakeGitHubUser = { id: 5001, login: "ci-helper[bot]", type: "Bot" };
  const labels = opts.labels ?? ["bug", "in progress", "in review", "optio"];
  const issues = new Map<number, FakeGitHubIssue>();
  let commentSeq = 700000;

  const addIssue = (n: number, state: "open" | "closed" = "open", l: string[] = ["optio"]) => {
    const issue: FakeGitHubIssue = {
      number: n,
      state,
      state_reason: null,
      labels: [...l],
      comments: [],
    };
    issues.set(n, issue);
    return issue;
  };
  const comment = (n: number, body: string, author = person, at = new Date()) => {
    const issue = issues.get(n) ?? addIssue(n);
    const c: FakeGitHubComment = {
      id: ++commentSeq,
      user: author,
      body,
      created_at: at.toISOString(),
      updated_at: at.toISOString(),
      performed_via_github_app: author.type === "Bot" ? { id: 77, slug: "ci-helper" } : null,
      author_association: author.association ?? "COLLABORATOR",
    };
    issue.comments.push(c);
    return c;
  };
  const view = (i: FakeGitHubIssue) => ({
    number: i.number,
    state: i.state,
    state_reason: i.state_reason,
    labels: i.labels.map((name) => ({ name })),
  });
  const repo = "/repos/acme/app";

  const http = await startFakeHttp(
    (call, reply) => {
      const { method, path, body } = call;
      if (method === "GET" && path === "/user")
        return opts.installation
          ? reply(403, { message: "Resource not accessible by integration" })
          : reply(200, bot);
      if (method === "GET" && path === "/installation/repositories" && opts.installation)
        return reply(200, { total_count: 1, repositories: [{ full_name: "acme/app" }] });
      if (method === "GET" && path === `${repo}/labels`) {
        const page = pageOf(
          labels.map((name) => ({ name })),
          call.query,
          `${GITHUB_API}${path}`,
        );
        return reply(200, page.items, page.headers);
      }
      const edit = path.match(/^\/repos\/acme\/app\/issues\/comments\/(\d+)$/);
      if (edit && method === "PATCH") {
        for (const i of issues.values()) {
          const c = i.comments.find((x) => x.id === Number(edit[1]));
          if (c) {
            c.body = String(body?.body ?? "");
            c.updated_at = new Date().toISOString();
            return reply(200, c);
          }
        }
        return reply(404, { message: "Not Found" });
      }
      const m = path.match(
        /^\/repos\/acme\/app\/issues\/(\d+)(?:\/(comments|labels)(?:\/([^/]+))?)?$/,
      );
      if (!m) return reply(404, { message: `No fake for ${method} ${path}` });
      const issue = issues.get(Number(m[1]));
      if (!issue) return reply(404, { message: "Not Found" });
      const [, , what, name] = m;
      if (!what && method === "GET") return reply(200, view(issue));
      if (!what && method === "PATCH") {
        if (body?.state === "open" || body?.state === "closed") {
          if (body.state !== issue.state) issue.state_reason = body.state_reason ?? null;
          issue.state = body.state;
        }
        return reply(200, view(issue));
      }
      if (what === "comments" && method === "GET") {
        const page = pageOf(issue.comments, call.query, `${GITHUB_API}${path}`);
        return reply(200, page.items, page.headers);
      }
      if (what === "comments" && method === "POST") {
        return reply(201, comment(issue.number, String(body?.body ?? ""), bot));
      }
      if (what === "labels" && method === "POST" && !name) {
        for (const l of (body?.labels ?? []) as string[]) {
          if (!issue.labels.includes(l)) issue.labels.push(l);
        }
        return reply(
          200,
          issue.labels.map((l) => ({ name: l })),
        );
      }
      if (what === "labels" && method === "DELETE" && name) {
        const label = decodeURIComponent(name);
        if (!issue.labels.includes(label)) return reply(404, { message: "Label does not exist" });
        issue.labels = issue.labels.filter((l) => l !== label);
        return reply(
          200,
          issue.labels.map((l) => ({ name: l })),
        );
      }
      return reply(404, { message: `No fake for ${method} ${path}` });
    },
    (headers) => headers.authorization === `Bearer ${token}`,
  );

  return {
    ...http,
    fetch: fetchRoutedTo({ [GITHUB_API]: http.url }),
    bot,
    person,
    stranger,
    app,
    labels,
    issues,
    addIssue,
    comment,
  };
}
