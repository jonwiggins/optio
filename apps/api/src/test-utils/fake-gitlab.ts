/**
 * An in-process stand-in for the parts of GitLab's API that Optio's GitLab
 * user calls (services/gitlab-bot/): `GET /user`, award emoji and notes on
 * merge requests and issues (threads too), project members, users, and a
 * merge request's pipeline, failed jobs and job logs. It is a `fetch`:
 *
 *   const gl = fakeGitLab({ host: "gitlab.example.test", bot: { id: 99, username: "optio-bot" } });
 *   vi.stubGlobal("fetch", gl.fetch);
 *   gl.members.set(501, 30);                 // user 501 is a Developer
 *   gl.notes;                                // what the bot posted
 *
 * Calls to any other host go to the real fetch.
 */

export interface FakeNote {
  projectId: string;
  noteable: "merge_requests" | "issues";
  iid: number;
  discussionId: string | null;
  body: string;
  auth: string | null;
}

export interface FakeAward {
  projectId: string;
  noteable: "merge_requests" | "issues";
  iid: number;
  noteId: number;
  name: string;
}

export interface FakeFailedJob {
  id: number;
  name: string;
  stage: string;
  log: string;
}

export interface FakeGitLab {
  fetch: typeof fetch;
  /** Every request, as `METHOD /path` (no query). */
  calls: string[];
  notes: FakeNote[];
  awards: FakeAward[];
  /** GitLab user id → access level on every project (absent: not a member). */
  members: Map<number, number>;
  /** GitLab user id → what `GET /users/:id` shows. */
  users: Map<number, { email?: string | null; public_email?: string | null }>;
  /** Head commit sha → its pipeline's failed jobs (absent: no pipeline; empty: none failed). */
  pipelines: Map<string, FakeFailedJob[]>;
  /** Make the next calls to a path fail with a status. */
  failing: Map<string, number>;
  reset(): void;
}

export function fakeGitLab(opts: {
  host: string;
  bot: { id: number; username: string; bot?: boolean };
  token?: string;
}): FakeGitLab {
  const realFetch = globalThis.fetch;
  let nextNoteId = 9000;
  const state: FakeGitLab = {
    fetch: (async () => new Response()) as unknown as typeof fetch,
    calls: [],
    notes: [],
    awards: [],
    members: new Map(),
    users: new Map(),
    pipelines: new Map(),
    failing: new Map(),
    reset() {
      state.calls.length = 0;
      state.notes.length = 0;
      state.awards.length = 0;
      state.members.clear();
      state.users.clear();
      state.pipelines.clear();
      state.failing.clear();
    },
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  state.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    if (url.host !== opts.host) return realFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api\/v4/, "");
    state.calls.push(`${method} ${path}`);
    const headers = new Headers(init?.headers);
    const auth =
      headers.get("private-token") ??
      headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      null;
    if (opts.token && auth !== opts.token) return json(401, { message: "401 Unauthorized" });
    const fail = state.failing.get(path);
    if (fail) return json(fail, { message: `${fail} failing` });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/user") return json(200, opts.bot);

    if ((m = path.match(/^\/users\/(\d+)$/)) && method === "GET") {
      return json(200, { id: Number(m[1]), ...(state.users.get(Number(m[1])) ?? {}) });
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/members\/all\/(\d+)$/)) && method === "GET") {
      const level = state.members.get(Number(m[2]));
      return level === undefined
        ? json(404, { message: "404 Not found" })
        : json(200, { id: Number(m[2]), access_level: level, state: "active" });
    }
    if (
      (m = path.match(
        /^\/projects\/([^/]+)\/(merge_requests|issues)\/(\d+)\/notes\/(\d+)\/award_emoji$/,
      )) &&
      method === "POST"
    ) {
      state.awards.push({
        projectId: decodeURIComponent(m[1]),
        noteable: m[2] as FakeAward["noteable"],
        iid: Number(m[3]),
        noteId: Number(m[4]),
        name: String(body.name),
      });
      return json(201, { id: 1, name: body.name });
    }
    if (
      (m = path.match(
        /^\/projects\/([^/]+)\/(merge_requests|issues)\/(\d+)(?:\/discussions\/([^/]+))?\/notes$/,
      )) &&
      method === "POST"
    ) {
      const discussionId = m[4] ? decodeURIComponent(m[4]) : null;
      if (discussionId === "gone") return json(404, { message: "404 Discussion Not Found" });
      state.notes.push({
        projectId: decodeURIComponent(m[1]),
        noteable: m[2] as FakeNote["noteable"],
        iid: Number(m[3]),
        discussionId,
        body: String(body.body),
        auth,
      });
      return json(201, { id: ++nextNoteId, body: body.body });
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/pipelines$/)) && method === "GET") {
      const sha = url.searchParams.get("sha") ?? "";
      return json(
        200,
        state.pipelines.has(sha) ? [{ id: 700, web_url: `https://${opts.host}/p/700` }] : [],
      );
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/pipelines\/(\d+)\/jobs$/)) && method === "GET") {
      const all = [...state.pipelines.values()].flat();
      return json(
        200,
        all.map((j) => ({ id: j.id, name: j.name, stage: j.stage, status: "failed" })),
      );
    }
    if ((m = path.match(/^\/projects\/([^/]+)\/jobs\/(\d+)\/trace$/)) && method === "GET") {
      const job = [...state.pipelines.values()].flat().find((j) => j.id === Number(m![2]));
      return job ? new Response(job.log, { status: 200 }) : json(404, { message: "404" });
    }
    return json(404, { message: `fake GitLab has no ${method} ${path}` });
  }) as typeof fetch;
  return state;
}
