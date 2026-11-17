import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;
const sockets: WebSocket[] = [];
beforeAll(async () => {
  server = await startApiServer();
  for (const name of ["ANTHROPIC_API_KEY", "CURSOR_API_KEY"]) {
    const res = await fetch(`${server.baseUrl}/api/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, value: "dummy-test-key" }),
    });
    expect([200, 201]).toContain(res.status);
  }
}, 150_000);
afterAll(async () => {
  for (const ws of sockets) ws.close();
  await server?.stop();
});

async function peer(path = "/ws/optio/chat") {
  const frames: any[] = [];
  const ws = new WebSocket(server.baseUrl.replace("http", "ws") + path);
  sockets.push(ws);
  ws.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  await waitFor(async () => frames.find((f) => f.type === "status"), { label: "chat ready" });
  return { ws, frames };
}

it("runs an ordinary session, restores history, deduplicates prompts and changes harness on its next turn", async () => {
  const first = await peer();
  const { sessionId, href } = first.frames.find((f) => f.type === "history");
  expect(href).toBe(`/work/${sessionId}`);
  const requestId = randomUUID();
  first.ws.send(
    JSON.stringify({
      type: "message",
      content: "Help me plan [[mock:script:claude --print]]",
      requestId,
    }),
  );
  await waitFor(
    async () =>
      first.frames.find(
        (f) => f.type === "text" && f.content.includes("script claude --print=present"),
      ),
    { label: "Claude harness command" },
  );
  await waitFor(
    async () =>
      first.frames.filter((f) => f.type === "status" && f.status === "ready").length === 2,
  );
  expect(
    first.frames.filter((f) => f.type === "error"),
    server.logs(),
  ).toEqual([]);
  const second = await peer();
  const history = second.frames.find((f) => f.type === "history");
  expect(history.sessionId).toBe(sessionId);
  expect(history.frames.filter((f: any) => f.type === "user_message")).toHaveLength(1);
  second.ws.send(
    JSON.stringify({
      type: "message",
      content: "Help me plan [[mock:script:claude --print]]",
      requestId,
    }),
  );
  await waitFor(async () => second.frames.find((f) => f.type === "queue"));
  expect(second.frames.filter((f) => f.type === "user_message")).toHaveLength(0);

  const res = await fetch(`${server.baseUrl}/api/optio/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentRuntime: "cursor", model: "" }),
  });
  expect(res.status).toBe(200);
  const page = await peer(`/ws/sessions/${sessionId}/chat`);
  second.ws.send(
    JSON.stringify({
      type: "message",
      content: "Continue [[mock:script:cursor-agent --print]]",
      requestId: randomUUID(),
    }),
  );
  await waitFor(
    async () =>
      second.frames.find(
        (f) => f.type === "text" && f.content.includes("script cursor-agent --print=present"),
      ),
    { label: "Cursor harness command" },
  );
  await waitFor(
    async () =>
      page.frames.find(
        (f) =>
          f.type === "chat_event" &&
          f.event.content?.includes("script cursor-agent --print=present"),
      ),
    { label: "same conversation on session page" },
  );
  const session = await fetch(`${server.baseUrl}/api/sessions/${sessionId}`).then((r) => r.json());
  expect(session.session).toMatchObject({ agentRuntime: "cursor", assistant: true });
}, 120_000);

it("queues while working, restores pending messages to another client and cancels before execution", async () => {
  const first = await peer();
  const requestId = randomUUID();
  first.ws.send(
    JSON.stringify({
      type: "message",
      content: "First queued test [[mock:sleep:3000]]",
      requestId,
    }),
  );
  await waitFor(async () =>
    first.frames.find((f) => f.type === "status" && f.status === "thinking"),
  );
  const secondId = randomUUID(),
    cancelledId = randomUUID();
  first.ws.send(
    JSON.stringify({ type: "message", content: "Second queued test", requestId: secondId }),
  );
  first.ws.send(
    JSON.stringify({ type: "message", content: "Must not run", requestId: cancelledId }),
  );
  await waitFor(async () =>
    first.frames.find(
      (f) => f.type === "queue" && f.messages.some((m: any) => m.requestId === cancelledId),
    ),
  );
  const other = await peer();
  await waitFor(async () =>
    other.frames.find(
      (f) => f.type === "queue" && f.messages.some((m: any) => m.requestId === secondId),
    ),
  );
  other.ws.send(JSON.stringify({ type: "cancel_queued", requestId: cancelledId }));
  await waitFor(async () =>
    other.frames.find(
      (f) => f.type === "queue" && f.messages.length === 1 && f.messages[0].requestId === secondId,
    ),
  );
  await waitFor(async () =>
    first.frames.find((f) => f.type === "user_message" && f.requestId === secondId),
  );
  await waitFor(
    async () => first.frames.filter((f) => f.type === "status" && f.status === "ready").length >= 3,
  );
  expect(first.frames.filter((f) => f.type === "user_message").map((f) => f.requestId)).toEqual([
    requestId,
    secondId,
  ]);
  expect(first.frames.filter((f) => f.type === "error")).toEqual([]);
}, 120_000);

it("runs two named assistants concurrently and reconnects to their own saved histories", async () => {
  const create = async (title: string) => {
    const response = await fetch(`${server.baseUrl}/api/optio/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).session;
  };
  const a = await create("Parallel A"),
    b = await create("Parallel B");
  try {
    const first = await peer(`/ws/optio/chat?sessionId=${a.id}`);
    const second = await peer(`/ws/optio/chat?sessionId=${b.id}`);
    first.ws.send(
      JSON.stringify({
        type: "message",
        content: "Only in A [[mock:sleep:2500]]",
        requestId: randomUUID(),
      }),
    );
    await waitFor(async () =>
      first.frames.some((f) => f.type === "status" && f.status === "thinking"),
    );
    second.ws.send(
      JSON.stringify({
        type: "message",
        content: "Only in B [[mock:sleep:2500]]",
        requestId: randomUUID(),
      }),
    );
    await waitFor(async () =>
      second.frames.some((f) => f.type === "status" && f.status === "thinking"),
    );
    expect(first.frames.filter((f) => f.type === "status").at(-1).status).toBe("thinking");
    for (const peer of [first, second])
      await waitFor(
        async () => peer.frames.filter((f) => f.type === "status").at(-1).status === "ready",
      );
    expect(first.frames.filter((f) => f.type === "user_message").map((f) => f.content)).toEqual([
      "Only in A [[mock:sleep:2500]]",
    ]);
    expect(second.frames.filter((f) => f.type === "user_message").map((f) => f.content)).toEqual([
      "Only in B [[mock:sleep:2500]]",
    ]);
    first.ws.close();
    const reconnected = await peer(`/ws/optio/chat?sessionId=${a.id}`);
    expect(
      reconnected.frames
        .find((f) => f.type === "history")
        .frames.filter((f: any) => f.type === "user_message")
        .map((f: any) => f.content),
    ).toEqual(["Only in A [[mock:sleep:2500]]"]);
    const renamed = await fetch(`${server.baseUrl}/api/optio/sessions/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Investigation" }),
    });
    expect((await renamed.json()).session.title).toBe("Investigation");
    const listed = await fetch(`${server.baseUrl}/api/optio/sessions`).then((r) => r.json());
    expect(listed.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.id }),
        expect.objectContaining({ id: b.id, title: "Investigation" }),
      ]),
    );
  } finally {
    for (const s of [a, b])
      expect(
        (await fetch(`${server.baseUrl}/api/optio/sessions/${s.id}`, { method: "DELETE" })).status,
      ).toBe(204);
  }
}, 120_000);
