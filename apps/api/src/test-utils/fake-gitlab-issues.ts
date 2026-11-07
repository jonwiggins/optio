import { fetchRoutedTo, pageOf, startFakeHttp, type FakeHttp } from "./fake-http.js";

/**
 * An in-process GitLab for tests of the ticket round trip on GitLab Issues
 * (@optio/ticket-providers gitlab-round-trip.ts): the REST v4 calls Optio
 * makes on one project, `acme/app`, with Bearer auth, and issues kept
 * in memory with their state, labels and notes (system notes too). Shaped
 * after GitLab's REST reference (issues, notes, labels, the current user);
 * a stand-in, not GitLab. (fake-gitlab.ts is the GitLab user's merge-request
 * calls, for services/gitlab-bot/.)
 *
 *   const gl = await startFakeGitLabIssues({ token: "glpat-1" });
 *   vi.stubGlobal("fetch", gl.fetch);       // https://gitlab.example.test → the fake
 *   gl.addIssue(7);
 *   // provider config → { token: "glpat-1", host: "gitlab.example.test", projectPath: "acme/app" }
 */

export const GITLAB_HOST = "gitlab.example.test";

export interface FakeGitLabUser {
  id: number;
  username: string;
  name: string;
  /** Their access to acme/app (members/all); default Developer (30), none = not a member. */
  accessLevel?: number | null;
}

export interface FakeGitLabNote {
  id: number;
  author: FakeGitLabUser;
  body: string;
  system: boolean;
  created_at: string;
}

export interface FakeGitLabIssue {
  iid: number;
  state: "opened" | "closed";
  labels: string[];
  notes: FakeGitLabNote[];
}

export interface FakeGitLabIssues extends FakeHttp {
  fetch: typeof fetch;
  bot: FakeGitLabUser;
  person: FakeGitLabUser;
  /** Someone who may comment on the project but not push to it (a Reporter). */
  reporter: FakeGitLabUser;
  labels: string[];
  issues: Map<number, FakeGitLabIssue>;
  addIssue(iid: number, state?: "opened" | "closed", labels?: string[]): FakeGitLabIssue;
  note(
    iid: number,
    body: string,
    author?: FakeGitLabUser,
    at?: Date,
    system?: boolean,
  ): FakeGitLabNote;
}

export async function startFakeGitLabIssues(
  opts: { token?: string; labels?: string[] } = {},
): Promise<FakeGitLabIssues> {
  const token = opts.token ?? "fake-gitlab-token";
  const bot: FakeGitLabUser = { id: 99, username: "optio-bot", name: "Optio Bot" };
  const person: FakeGitLabUser = { id: 11, username: "ada", name: "Ada Lovelace" };
  const reporter: FakeGitLabUser = { id: 12, username: "eve", name: "Eve", accessLevel: 20 };
  const users = [bot, person, reporter];
  const labels = opts.labels ?? ["bug", "workflow::doing", "workflow::review", "optio"];
  const issues = new Map<number, FakeGitLabIssue>();
  let noteSeq = 4000;

  const addIssue = (iid: number, state: "opened" | "closed" = "opened", l = ["optio"]) => {
    const issue: FakeGitLabIssue = { iid, state, labels: [...l], notes: [] };
    issues.set(iid, issue);
    return issue;
  };
  const note = (iid: number, body: string, author = person, at = new Date(), system = false) => {
    const issue = issues.get(iid) ?? addIssue(iid);
    const n: FakeGitLabNote = { id: ++noteSeq, author, body, system, created_at: at.toISOString() };
    issue.notes.push(n);
    return n;
  };
  const view = (i: FakeGitLabIssue) => ({ iid: i.iid, state: i.state, labels: [...i.labels] });
  const project = "/api/v4/projects/acme%2Fapp";

  const http = await startFakeHttp(
    (call, reply) => {
      const { method, path, body } = call;
      if (method === "GET" && path === "/api/v4/user") return reply(200, bot);
      if (
        method === "GET" &&
        (path === `${project}/labels` || path === "/api/v4/groups/acme/labels")
      ) {
        const page = pageOf(
          labels.map((name) => ({ name })),
          call.query,
          path,
        );
        return reply(200, page.items, { "x-total-pages": page.headers["x-total-pages"] });
      }
      const member = path.match(/^\/api\/v4\/projects\/acme%2Fapp\/members\/all\/(\d+)$/);
      if (member && method === "GET") {
        const u = users.find((x) => x.id === Number(member[1]));
        const level = u ? (u.accessLevel === undefined ? 30 : u.accessLevel) : null;
        if (level === null) return reply(404, { message: "404 Not found" });
        return reply(200, {
          id: u!.id,
          username: u!.username,
          access_level: level,
          state: "active",
        });
      }
      if (!path.startsWith(`${project}/issues/`)) {
        return reply(404, { message: `No fake for ${method} ${path}` });
      }
      const m = path.slice(project.length).match(/^\/issues\/(\d+)(?:\/notes(?:\/(\d+))?)?$/);
      if (!m) return reply(404, { message: `No fake for ${method} ${path}` });
      const issue = issues.get(Number(m[1]));
      if (!issue) return reply(404, { message: "404 Issue Not Found" });
      const isNotes = path.includes("/notes");
      if (!isNotes && method === "GET") return reply(200, view(issue));
      if (!isNotes && method === "PUT") {
        if (body?.state_event === "close") issue.state = "closed";
        if (body?.state_event === "reopen") issue.state = "opened";
        const split = (v: unknown) =>
          typeof v === "string"
            ? v
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean)
            : [];
        issue.labels = issue.labels.filter((l) => !split(body?.remove_labels).includes(l));
        for (const l of split(body?.add_labels))
          if (!issue.labels.includes(l)) issue.labels.push(l);
        return reply(200, view(issue));
      }
      if (isNotes && !m[2] && method === "GET") {
        const desc = call.query.get("sort") !== "asc";
        const all = [...issue.notes].sort((a, b) => (desc ? b.id - a.id : a.id - b.id));
        const page = pageOf(all, call.query, path);
        return reply(200, page.items, { "x-total-pages": page.headers["x-total-pages"] });
      }
      if (isNotes && !m[2] && method === "POST") {
        return reply(201, note(issue.iid, String(body?.body ?? ""), bot));
      }
      if (isNotes && m[2] && method === "PUT") {
        const n = issue.notes.find((x) => x.id === Number(m[2]));
        if (!n) return reply(404, { message: "404 Note Not Found" });
        n.body = String(body?.body ?? n.body);
        return reply(200, n);
      }
      return reply(404, { message: `No fake for ${method} ${path}` });
    },
    (headers) => headers.authorization === `Bearer ${token}`,
  );

  return {
    ...http,
    fetch: fetchRoutedTo({ [`https://${GITLAB_HOST}`]: http.url }),
    bot,
    person,
    reporter,
    labels,
    issues,
    addIssue,
    note,
  };
}
