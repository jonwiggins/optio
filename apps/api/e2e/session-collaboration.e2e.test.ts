import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const workspace = randomUUID();
const tokens: string[] = [];
const sockets: WebSocket[] = [];
beforeAll(async () => {
  await sql`INSERT INTO workspaces (id, name, slug) VALUES (${workspace}, 'Collaboration', ${workspace})`;
  for (let i = 0; i < 3; i++) {
    const user = randomUUID(),
      token = `optio_pat_${randomBytes(32).toString("hex")}`;
    tokens.push(token);
    await sql`INSERT INTO users (id, provider, external_id, email, display_name, default_workspace_id)
      VALUES (${user}, 'github', ${user}, ${`${user}@example.com`}, 'Collaborator', ${workspace})`;
    await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspace}, ${user}, ${i === 2 ? "viewer" : "member"})`;
    await sql`INSERT INTO api_keys (user_id, name, prefix, hashed_key) VALUES (${user}, 'test', ${token.slice(0, 12)}, ${createHash("sha256").update(token).digest("hex")})`;
  }
  server = await startApiServer({ env: { OPTIO_AUTH_DISABLED: "false" } });
}, 150_000);
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await server?.stop();
  await sql.end();
});
async function call(who: number, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}
function peer(who: number, id: string) {
  const frames: Record<string, any>[] = [];
  const ws = new WebSocket(`${server.baseUrl.replace(/^http/, "ws")}/ws/sessions/${id}/chat`, [
    "optio-ws-v1",
    `optio-auth-${tokens[who]}`,
  ]);
  sockets.push(ws);
  ws.onmessage = (event) => {
    if (typeof event.data === "string") frames.push(JSON.parse(event.data));
  };
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (event) => resolve(event.code);
  });
  return {
    ws,
    frames,
    closed,
    ready: () =>
      waitFor(async () => frames.find((f) => f.type === "history_done"), { timeoutMs: 15_000 }),
  };
}
it("collaborates with org sign-in, records one turn, rejects duplicate input and revokes live access", async () => {
  const created = await call(0, "/api/sessions", "POST", {
    repoUrl: "https://github.com/test/shared-session",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.session.id;
  expect((await call(1, `/api/sessions/${id}`)).status).toBe(404);
  const share = await call(0, `/api/session-shares/pod/${id}`, "POST", {});
  expect(share.status, JSON.stringify(share.body)).toBe(201);
  const token = share.body.path.split("#")[1];
  expect((await call(2, "/api/session-shares/redeem", "POST", { token })).status).toBe(403);
  expect((await call(1, "/api/session-shares/redeem", "POST", { token })).status).toBe(200);
  expect((await call(1, `/api/sessions/${id}`)).status).toBe(200);
  expect((await call(1, `/api/sessions/${id}/end`, "POST")).status).toBe(404);
  const owner = peer(0, id),
    colleague = peer(1, id);
  await Promise.all([owner.ready(), colleague.ready()]);
  const requestId = randomUUID();
  const prompt = { type: "message", content: "Describe this workspace", requestId };
  colleague.ws.send(JSON.stringify(prompt));
  await waitFor(async () =>
    owner.frames.find((f) => f.type === "user_message" && f.requestId === requestId),
  );
  await waitFor(
    async () => {
      const [turn] =
        await sql`SELECT state FROM session_chat_turns WHERE session_id = ${id} AND request_id = ${requestId}`;
      return turn?.state === "completed";
    },
    { label: "shared chat turn completes" },
  );
  colleague.ws.send(JSON.stringify(prompt));
  await waitFor(async () =>
    colleague.frames.find((f) => f.type === "error" && f.message.includes("already accepted")),
  );
  const [count] =
    await sql`SELECT count(*)::int AS n FROM session_chat_events WHERE session_id = ${id} AND log_type = 'user_message'`;
  expect(count.n).toBe(1);
  expect((await call(0, `/api/session-shares/pod/${id}/${share.body.id}`, "DELETE")).status).toBe(
    200,
  );
  expect(await colleague.closed).toBe(4403);
  expect((await call(1, `/api/sessions/${id}/chat`)).status).toBe(404);
  owner.ws.close();
  // A durable running receipt survives an API upgrade as interrupted; never replay it.
  const pendingId = randomUUID();
  await sql`INSERT INTO session_chat_turns (session_id, request_id, prompt_hash, state) VALUES (${id}, ${pendingId}, 'unknown-outcome', 'running')`;
  await server.stop();
  server = await startApiServer({ env: { OPTIO_AUTH_DISABLED: "false" } });
  const [recovered] =
    await sql`SELECT state FROM session_chat_turns WHERE request_id = ${pendingId}`;
  expect(recovered.state).toBe("interrupted");
  expect((await call(0, `/api/session-recovery/pod/${id}`)).body.automaticReplay).toBe(false);
}, 120_000);
