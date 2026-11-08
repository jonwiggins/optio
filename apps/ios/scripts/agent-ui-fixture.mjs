// Isolated, in-memory protocol fixture for OptioAssistantWorkspaceUITests.
// Run: node apps/ios/scripts/agent-ui-fixture.mjs
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const apiRequire = createRequire(new URL("../../api/package.json", import.meta.url));
const { WebSocketServer } = createRequire(apiRequire.resolve("@fastify/websocket"))("ws");
const sessions = [
  [
    "Plan the next release",
    "ready",
    "Here’s a focused plan for the release.\n\n**Start with the experience**\nPolish the agent workspace, then verify session recovery on every device.\n\n| Area | Next step |\n| --- | --- |\n| iOS | Review session switching |\n| Web | Verify shared history |\n\nYour existing work will continue while we plan.",
  ],
  [
    "Review the sign-in flow",
    "waiting_for_approval",
    "I’ve found a small change that will make sign-in clearer. Review the proposed work below.",
  ],
  [
    "Investigate slow builds",
    "thinking",
    "I’m comparing the recent builds and checking where time is being spent.",
  ],
  ...Array.from({ length: 6 }, (_, i) => [
    `Workspace idea ${i + 1}`,
    "ready",
    "Ready to explore this idea together.",
  ]),
].map(([title, status, text]) => ({
  id: randomUUID(),
  title,
  createdAt: new Date().toISOString(),
  status,
  frames: [
    { type: "user_message", content: "Help me make progress on this.", requestId: randomUUID() },
    { type: "text", content: text },
  ],
  queue: [],
  clients: new Set(),
}));
const send = (s, f) => s.clients.forEach((c) => c.readyState === 1 && c.send(JSON.stringify(f)));
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const b = raw ? JSON.parse(raw) : {};
  const path = new URL(req.url, "http://localhost").pathname;
  const json = (v, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(v));
  };
  if (path === "/fixture") return json({ fixture: "optio-agent-ui" });
  if (path === "/api/auth/me")
    return json({
      user: { id: "fixture", displayName: "UI Tester", workspaceRole: "admin" },
      authDisabled: true,
    });
  if (path === "/api/optio/sessions") {
    if (req.method === "GET")
      return json({
        sessions: sessions.map(({ id, title, createdAt }) => ({ id, title, createdAt })),
      });
    const s = {
      id: randomUUID(),
      title: b.title || "New session",
      createdAt: new Date().toISOString(),
      status: "ready",
      frames: [],
      queue: [],
      clients: new Set(),
    };
    sessions.push(s);
    return json({ session: s }, 201);
  }
  const match = path.match(/^\/api\/optio\/sessions\/([^/]+)$/);
  if (match) {
    const i = sessions.findIndex((s) => s.id === match[1]);
    if (i < 0) return json({ error: "Not found" }, 404);
    if (req.method === "PATCH") {
      sessions[i].title = b.title;
      return json({ session: sessions[i] });
    }
    if (req.method === "DELETE") {
      sessions[i].clients.forEach((c) => c.close());
      sessions.splice(i, 1);
      res.writeHead(204);
      return res.end();
    }
  }
  if (path === "/api/optio/settings")
    return json({
      settings: {
        agentRuntime: "codex",
        model: "gpt-5.4",
        enabledTools: [],
        confirmWrites: true,
        maxTurns: 20,
      },
    });
  return json({
    tasks: [],
    sessions: [],
    repos: [],
    agents: [],
    hosts: [],
    items: [],
    work: [],
    total: 0,
  });
});
const wss = new WebSocketServer({ server, handleProtocols: () => "optio-ws-v1" });
wss.on("connection", (ws, req) => {
  const id = new URL(req.url, "http://localhost").searchParams.get("sessionId");
  const s = sessions.find((s) => s.id === id);
  if (!s) return;
  s.clients.add(ws);
  ws.on("close", () => s.clients.delete(ws));
  ws.send(
    JSON.stringify({ type: "history", sessionId: s.id, href: `/work/${s.id}`, frames: s.frames }),
  );
  if (s.status === "waiting_for_approval")
    ws.send(
      JSON.stringify({
        type: "action_proposal",
        actionId: "proposal",
        description: "Improve the sign-in experience",
        items: [],
        work: [
          {
            name: "Clarify sign-in errors",
            when: { type: "manual" },
            where: { runTarget: "pod" },
            who: { runtime: "codex" },
            what: { prompt: "Improve the sign-in error copy and add coverage." },
            then: "exits",
          },
        ],
      }),
    );
  ws.send(JSON.stringify({ type: "queue", messages: s.queue }));
  ws.send(JSON.stringify({ type: "status", status: s.status, runtime: "codex", model: "gpt-5.4" }));
  ws.on("message", (data) => {
    const f = JSON.parse(data);
    if (f.type === "interrupt") {
      s.frames = [];
      send(s, { type: "history", sessionId: s.id, frames: [] });
    }
    if (f.type === "message") {
      if (s.status !== "ready") {
        s.queue.push({ requestId: f.requestId, content: f.content });
        send(s, { type: "queue", messages: s.queue });
      } else {
        const user = { type: "user_message", requestId: f.requestId, content: f.content };
        s.frames.push(user);
        send(s, user);
        send(s, { type: "status", status: "thinking" });
        setTimeout(() => {
          const answer = { type: "text", content: "This reply belongs only to this session." };
          s.frames.push(answer);
          send(s, answer);
          send(s, { type: "status", status: "ready" });
        }, 1000);
      }
    }
    if (f.type === "cancel_queued") {
      s.queue = s.queue.filter((q) => q.requestId !== f.requestId);
      send(s, { type: "queue", messages: s.queue });
    }
    if (f.type === "approve" || f.type === "deny") {
      s.status = "ready";
      send(s, { type: "action_decision", actionId: f.actionId, approved: f.type === "approve" });
      send(s, { type: "status", status: "ready" });
    }
  });
});
server.listen(4978, "127.0.0.1", () => console.log("Isolated iOS Agent fixture on 4978"));
