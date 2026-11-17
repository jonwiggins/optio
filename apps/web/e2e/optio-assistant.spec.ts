import { expect, test, type Locator } from "@playwright/test";

async function selectSession(panel: Locator, name: string) {
  const tab = panel.getByRole("tab", { name, exact: true });
  if (await tab.isVisible()) await tab.click();
  else {
    await panel.getByRole("button", { name: "All sessions", exact: true }).click();
    await panel
      .getByRole("region", { name: "All sessions", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
  }
}

const work = {
  name: "Investigate login",
  when: { type: "manual" },
  where: { runTarget: "local", localHostId: "test-machine", localDir: "/Users/jon/repos/optio" },
  who: { runtime: "codex" },
  what: { prompt: "Investigate the login issue" },
  then: "waits-for-me",
};

test("dictate, edit, send, approve work and navigate without losing the conversation", async ({
  page,
}) => {
  const received: Array<Record<string, any>> = [];
  await page.addInitScript(() => {
    class SpeechRecognition {
      onstart?: () => void;
      onend?: () => void;
      onresult?: (event: unknown) => void;
      start() {
        this.onstart?.();
        this.onresult?.({
          results: [{ isFinal: true, 0: { transcript: "Start Codex on my Mac" } }],
        });
      }
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    Object.assign(window, { SpeechRecognition });
  });
  await page.routeWebSocket("**/ws/optio/chat*", (ws) => {
    ws.send(JSON.stringify({ type: "status", status: "ready" }));
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      received.push(frame);
      if (frame.type === "message") {
        ws.send(
          JSON.stringify({
            type: "text",
            content: "I’ll start an interactive Codex session on your Mac.",
          }),
        );
        ws.send(
          JSON.stringify({
            type: "action_proposal",
            actionId: "create-1",
            description: "Ready to create this work",
            items: [],
            work: [work],
          }),
        );
        ws.send(JSON.stringify({ type: "status", status: "waiting_for_approval" }));
      }
      if (frame.type === "approve") {
        ws.send(JSON.stringify({ type: "action_result", success: true, summary: "Work created." }));
        ws.send(JSON.stringify({ type: "text", content: "[View your work](/work)" }));
        ws.send(JSON.stringify({ type: "status", status: "ready" }));
      }
    });
  });
  const response = await page.goto("/");
  expect(await response!.headerValue("permissions-policy")).toContain("microphone=(self)");
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  const panel = page.getByRole("dialog", { name: "Optio assistant" });
  await expect(panel.getByRole("tabpanel").getByText("What would you like")).toBeVisible();
  await panel.getByRole("button", { name: "Start dictation" }).click();
  const draft = panel.getByRole("textbox", { name: "Message Optio" });
  await expect(draft).toHaveValue("Start Codex on my Mac");
  await expect(panel.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(received).toHaveLength(0);
  await panel.getByRole("button", { name: "Stop dictation" }).click();
  await draft.fill("Start Codex on my Mac to investigate the login issue");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByText("Ready to create this work")).toBeVisible();
  await expect(panel.locator("dd").filter({ hasText: "/Users/jon/repos/optio" })).toBeVisible();
  expect(received.map((f) => f.type)).toEqual(["message"]);
  await panel.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(panel.getByText("Work created.")).toBeVisible();
  expect(received.map((f) => f.type)).toEqual(["message", "approve"]);
  await panel.getByRole("link", { name: "View your work" }).click();
  await expect(page).toHaveURL(/\/work$/);
  await expect(panel.getByText("Work created.")).toBeVisible();
  const resize = panel.getByRole("button", { name: "Resize panel width", exact: true });
  await resize.focus();
  await resize.press("Shift+ArrowRight");
  await expect(panel).toHaveCSS("width", "584px");
  await page.screenshot({ path: "/tmp/optio-assistant-desktop.png" });
  await panel.getByRole("button", { name: "Minimize Optio" }).click();
  await expect(panel).not.toBeVisible();
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  await expect(panel.getByText("Work created.")).toBeVisible();
});

test("mobile composer fits and the real session restores conversation history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto("/");
  expect(await response!.headerValue("permissions-policy")).toContain("microphone=(self)");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  const panel = page.getByRole("dialog", { name: "Optio assistant" });
  await expect(panel).toBeVisible();
  await panel.getByRole("textbox", { name: "Message Optio" }).fill("List my work");
  await expect(panel.getByRole("button", { name: "Send message" })).toBeEnabled();
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByRole("link", { name: "Open in session" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(panel.getByText(/Mock agent|Task completed|mock agent/i).first()).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  await expect(panel.getByText("List my work", { exact: true }).last()).toBeVisible();
  expect((await panel.boundingBox())!.width).toBe(390);
  await page.screenshot({ path: "/tmp/optio-assistant-mobile.png" });
  const sessionLink = panel.getByRole("link", { name: "Open in session" });
  await expect(sessionLink).toHaveAttribute("href", /^\/work\/[0-9a-f-]{36}$/);
  await sessionLink.click();
  await expect(page).toHaveURL(/\/work\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(panel).toBeHidden();
  await expect(page.locator("main")).toContainText("List my work");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "All work", exact: true }).click();
  await expect(page).toHaveURL(/\/work$/);
});

test("dictation remains usable while chat is disconnected and reports a silent speech failure", async ({
  page,
}) => {
  await page.addInitScript(() => {
    class SpeechRecognition {
      onend?: () => void;
      start() {
        this.onend?.();
      }
      abort() {}
    }
    Object.assign(window, { SpeechRecognition });
  });
  await page.routeWebSocket("**/ws/optio/chat*", (ws) => ws.close());
  await page.goto("/");
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  const panel = page.getByRole("dialog", { name: "Optio assistant" });
  await expect(panel.getByRole("status", { name: "Disconnected", exact: true })).toBeVisible();
  await panel.getByRole("textbox", { name: "Message Optio" }).fill("Keep my draft");
  await panel.getByRole("button", { name: "Start dictation" }).click();
  await expect(panel.getByRole("alert")).toContainText("Dictation ended without any text");
  await expect(panel.getByRole("textbox", { name: "Message Optio" })).toHaveValue("Keep my draft");
});

test("unsupported dictation is disabled with an explanation on hover", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { SpeechRecognition: undefined, webkitSpeechRecognition: undefined });
  });
  await page.routeWebSocket("**/ws/optio/chat*", (ws) => ws.close());
  await page.goto("/");
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  const panel = page.getByRole("dialog", { name: "Optio assistant" });
  const dictate = panel.getByRole("button", { name: "Start dictation" });
  await expect(dictate).toBeDisabled();
  await expect(dictate).toHaveAttribute("title", /doesn’t provide speech recognition/);
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("anchor docks the assistant beside the page and remembers the preference", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.routeWebSocket("**/ws/optio/chat*", (ws) => {
    ws.send(JSON.stringify({ type: "status", status: "ready" }));
  });
  await page.goto("/work");
  const main = page.locator("main");
  const full = (await main.boundingBox())!;
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  const panel = page.getByRole("dialog", { name: "Optio assistant" });
  const draft = panel.getByRole("textbox", { name: "Message Optio" });
  await draft.fill("Keep this draft while I arrange the page");
  expect((await main.boundingBox())!.width).toBe(full.width);
  await panel.getByRole("button", { name: "Dock assistant", exact: true }).click();
  await expect(panel).toHaveCSS("position", "static");
  const docked = (await main.boundingBox())!;
  const assistant = (await panel.boundingBox())!;
  expect(assistant.x + assistant.width).toBeLessThanOrEqual(docked.x + 1);
  expect(docked.width).toBeLessThan(full.width - 300);
  await expect(draft).toHaveValue("Keep this draft while I arrange the page");
  await panel.getByRole("button", { name: "Minimize Optio" }).click();
  expect((await main.boundingBox())!.width).toBe(full.width);
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  await expect(panel).toHaveCSS("position", "static");
  await page.reload();
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  await expect(panel).toHaveCSS("position", "static");
  await page.screenshot({ path: "/tmp/optio-assistant-docked.png" });
  await panel.getByRole("button", { name: "Float assistant" }).click();
  await expect(panel).toHaveCSS("position", "fixed");
  expect((await main.boundingBox())!.width).toBe(full.width);
});

test("header, welcome and composer stay separated in short and narrow windows", async ({
  page,
}) => {
  await page.routeWebSocket("**/ws/optio/chat*", (ws) => {
    ws.send(
      JSON.stringify({
        type: "history",
        href: "/work/12345678-1234-1234-1234-123456789abc",
        frames: [],
      }),
    );
    ws.send(
      JSON.stringify({ type: "status", status: "ready", runtime: "codex", model: "test-model" }),
    );
  });
  for (const viewport of [
    { width: 1280, height: 500 },
    { width: 1024, height: 600 },
    { width: 390, height: 500 },
    { width: 320, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    if (viewport.width < 768) await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("button", { name: /Optio Agent/ }).click();
    const panel = page.getByRole("dialog", { name: "Optio assistant" });
    await expect(panel.getByRole("heading", { name: "Optio Agent", exact: true })).toBeVisible();
    await expect(panel.getByRole("img", { name: "OpenAI Codex · test-model" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Open in session" })).toBeVisible();
    await expect(panel.getByText("You review actions before Optio runs them.")).toHaveCount(0);
    await panel.getByRole("textbox", { name: "Message Optio" }).fill("");
    const emptyComposer = (await panel
      .getByRole("tabpanel")
      .getByTestId("optio-composer")
      .boundingBox())!;
    expect(emptyComposer.height).toBeLessThanOrEqual(115);
    const scroll = panel.getByRole("tabpanel").getByTestId("optio-conversation-scroll");
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(0);
    const header = (await panel.getByRole("tabpanel").locator("header").boundingBox())!;
    const intro = (await panel
      .getByRole("tabpanel")
      .getByText("FROM IDEA TO RUNNING WORK")
      .boundingBox())!;
    expect(intro.y).toBeGreaterThanOrEqual(header.y + header.height);
    const field = panel.getByRole("textbox", { name: "Message Optio" });
    await field.fill("A longer draft\n".repeat(20));
    const input = (await field.boundingBox())!;
    const send = (await panel.getByRole("button", { name: "Send message" }).boundingBox())!;
    expect(send.y).toBeGreaterThanOrEqual(input.y + input.height + 8);
    expect(send.y + send.height).toBeLessThanOrEqual(viewport.height);
    const footer = (await panel.getByRole("tabpanel").getByTestId("optio-composer").boundingBox())!;
    const conversation = (await scroll.boundingBox())!;
    expect(conversation.y + conversation.height).toBeLessThanOrEqual(footer.y + 1);
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({
      path: `/tmp/optio-assistant-${viewport.width}-${viewport.height}.png`,
    });
  }
});

test(
  "assistant settings save each supported harness and its default model",
  { tag: "@form-logic" },
  async ({ page, request }) => {
    const original = (await (await request.get("/api/optio/settings")).json()).settings;
    try {
      await page.goto("/settings#agents");
      const harness = page.getByRole("group", { name: "Assistant harness" });
      await expect(harness).toBeVisible();
      for (const runtime of ["codex", "copilot", "gemini", "opencode", "cursor", "claude-code"]) {
        const label = (
          {
            codex: "OpenAI Codex",
            copilot: "GitHub Copilot",
            gemini: "Google Gemini",
            opencode: "OpenCode",
            cursor: "Cursor",
            "claude-code": "Claude Code",
          } as Record<string, string>
        )[runtime];
        await harness.getByRole("button", { name: label, exact: true }).click();
        const saved = page.waitForResponse(
          (r) => r.url().endsWith("/api/optio/settings") && r.request().method() === "PUT",
        );
        await page.getByRole("button", { name: "Save Settings", exact: true }).click();
        const response = await saved;
        expect(response.status()).toBe(200);
        expect((await response.json()).settings).toMatchObject({
          agentRuntime: runtime,
          model: "",
          enabledTools: [],
        });
        await page.reload();
        await expect(harness.getByRole("button", { name: label, exact: true })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
      }
    } finally {
      const {
        agentRuntime,
        agentOptions,
        model,
        systemPrompt,
        enabledTools,
        confirmWrites,
        maxTurns,
      } = original;
      expect(
        (
          await request.put("/api/optio/settings", {
            data: {
              agentRuntime,
              agentOptions,
              model,
              systemPrompt,
              enabledTools,
              confirmWrites,
              maxTurns,
            },
          })
        ).ok(),
      ).toBe(true);
    }
  },
);

test(
  "messages queue while working, can be removed, and the gear opens agent settings",
  { tag: "@form-logic" },
  async ({ page }) => {
    const received: any[] = [];
    await page.routeWebSocket("**/ws/optio/chat*", (ws) => {
      ws.send(
        JSON.stringify({
          type: "status",
          status: "thinking",
          runtime: "codex",
          model: "test-model",
        }),
      );
      ws.send(JSON.stringify({ type: "text", content: "Working on your first request" }));
      ws.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        received.push(frame);
        if (frame.type === "message")
          ws.send(
            JSON.stringify({
              type: "queue",
              messages: [{ requestId: frame.requestId, content: frame.content }],
            }),
          );
        if (frame.type === "cancel_queued")
          ws.send(JSON.stringify({ type: "queue", messages: [] }));
      });
    });
    await page.goto("/work");
    await page.getByRole("button", { name: /Optio Agent/ }).click();
    const panel = page.getByRole("dialog", { name: "Optio assistant" });
    await panel.getByRole("textbox", { name: "Message Optio" }).fill("Then check the tests");
    await expect(panel.getByRole("button", { name: "Send message" })).toBeEnabled();
    await panel.getByRole("button", { name: "Send message" }).click();
    const queue = panel.getByRole("region", { name: "Queued messages" });
    await expect(queue.getByText("Then check the tests", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Session details" }).click();
    await expect(panel.getByRole("button", { name: "Clear conversation" })).toBeDisabled();
    await panel.getByRole("button", { name: "Session details" }).click();
    await queue
      .getByRole("button", { name: "Remove queued message: Then check the tests" })
      .click();
    await expect(queue).toBeHidden();
    expect(received.map((f) => f.type)).toEqual(["message", "cancel_queued"]);
    await panel.getByRole("button", { name: "Session details" }).click();
    await panel.getByRole("link", { name: "Optio agent settings" }).click();
    await expect(page).toHaveURL(/\/settings#agents$/);
    await expect(panel).toBeHidden();
    await expect(page.getByRole("group", { name: "Assistant harness" })).toBeVisible();
  },
);

test("independent tabs keep drafts, background replies and approvals through switching and refresh", async ({
  page,
  request,
}) => {
  const create = async (title: string) => {
    const response = await request.post("/api/optio/sessions", { data: { title } });
    expect(response.status()).toBe(201);
    return (await response.json()).session;
  };
  const a = await create("Planning"),
    b = await create("Investigation");
  const created = [a, b];
  const connections = new Map<string, import("@playwright/test").WebSocketRoute>();
  const sent: Array<{ id: string; frame: any }> = [];
  await page.routeWebSocket("**/ws/optio/chat*", (ws) => {
    const id = new URL(ws.url()).searchParams.get("sessionId")!;
    connections.set(id, ws);
    ws.send(JSON.stringify({ type: "history", href: `/work/${id}`, frames: [] }));
    ws.send(JSON.stringify({ type: "status", status: "ready" }));
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      sent.push({ id, frame });
      if (frame.type === "approve") {
        ws.send(
          JSON.stringify({ type: "action_decision", actionId: frame.actionId, approved: true }),
        );
        ws.send(JSON.stringify({ type: "status", status: "ready" }));
      }
    });
  });
  try {
    await page.goto("/work");
    await page.getByRole("button", { name: /Optio Agent/ }).click();
    const panel = page.getByRole("dialog", { name: "Optio assistant" });
    await selectSession(panel, "Planning");
    const draft = panel.getByRole("textbox", { name: "Message Optio" });
    await draft.fill("Keep the planning draft");
    await selectSession(panel, "Investigation");
    await expect(draft).toHaveValue("");
    await draft.fill("Keep the investigation draft");
    connections.get(a.id)!.send(
      JSON.stringify({
        type: "action_proposal",
        actionId: "planning-action",
        description: "Planning approval",
        items: ["Create planned work"],
      }),
    );
    connections.get(a.id)!.send(JSON.stringify({ type: "status", status: "waiting_for_approval" }));
    await expect(panel.locator(`#optio-tab-${a.id}`)).toHaveAttribute("title", /Needs approval/);
    await expect(panel.getByText("Planning approval", { exact: true })).toBeHidden();
    await selectSession(panel, "Planning");
    await expect(draft).toHaveValue("Keep the planning draft");
    await panel.getByRole("button", { name: "Approve", exact: true }).click();
    expect(sent).toEqual([{ id: a.id, frame: { type: "approve", actionId: "planning-action" } }]);
    connections
      .get(b.id)!
      .send(JSON.stringify({ type: "text", content: "Background investigation is finished." }));
    await expect(panel.locator(`#optio-tab-${b.id}`)).toHaveAttribute("title", /New reply/);
    await selectSession(panel, "Investigation");
    await expect(
      panel.getByText("Background investigation is finished.", { exact: true }),
    ).toBeVisible();
    await expect(draft).toHaveValue("Keep the investigation draft");
    await panel.getByRole("button", { name: "Session details" }).click();
    await panel.getByRole("textbox", { name: "Session name" }).fill("Login investigation");
    await panel.getByRole("button", { name: "Save session name" }).click();
    await expect(
      panel.getByRole("tab", { name: "Login investigation", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "/tmp/optio-agent-sessions.png" });
    await page.reload();
    await page.getByRole("button", { name: /Optio Agent/ }).click();
    await expect(
      panel.getByRole("tab", { name: "Login investigation", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(draft).toHaveValue("Keep the investigation draft");
    await selectSession(panel, "Planning");
    await expect(draft).toHaveValue("Keep the planning draft");
    await panel.getByRole("button", { name: "Session details" }).click();
    await panel.getByRole("button", { name: "End session", exact: true }).click();
    await expect(panel.getByRole("tab", { name: "Planning", exact: true })).toHaveCount(0);
    const resize = panel.getByRole("button", { name: "Resize panel width", exact: true });
    await resize.focus();
    await resize.press("Shift+ArrowLeft");
    await resize.press("Shift+ArrowLeft");
    const saved = page.waitForResponse(
      (r) => r.url().endsWith("/api/optio/sessions") && r.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "New agent session" }).click();
    const newSession = (await (await saved).json()).session;
    created.push(newSession);
    const newTab = panel.locator(`#optio-tab-${newSession.id}`);
    await expect(newTab).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(async () => {
        const tabBox = (await newTab.boundingBox())!;
        const listBox = (await panel.getByRole("tablist").boundingBox())!;
        return (
          tabBox.x >= listBox.x - 1 && tabBox.x + tabBox.width <= listBox.x + listBox.width + 1
        );
      })
      .toBe(true);
    await expect(draft).toHaveValue("");
    await panel.getByRole("button", { name: "Session details" }).click();
    await panel.getByRole("button", { name: "End session", exact: true }).click();
    await expect(newTab).toHaveCount(0);
  } finally {
    for (const s of created) await request.delete(`/api/optio/sessions/${s.id}`);
  }
});

test("freeform resizing stays inside the page, survives refresh and adapts to a smaller viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.routeWebSocket("**/ws/optio/chat*", (ws) =>
    ws.send(JSON.stringify({ type: "status", status: "ready" })),
  );
  await page.goto("/work");
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  const panel = page.getByRole("dialog", { name: "Optio assistant" });
  const initial = (await panel.boundingBox())!;
  const sidebar = (await page
    .getByRole("complementary", { name: "Sidebar", exact: true })
    .boundingBox())!;
  expect(initial.x).toBe(sidebar.x + sidebar.width + 12);
  const header = panel.getByRole("tabpanel").locator("header");
  await expect(header.getByRole("tablist")).toBeVisible();
  expect((await header.boundingBox())!.height).toBeLessThan(55);
  const handle = panel.getByRole("button", { name: "Resize panel", exact: true });
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + 6, grip.y + 6);
  await page.mouse.down();
  await page.mouse.move(grip.x + 126, grip.y - 80);
  await page.mouse.up();
  const resized = (await panel.boundingBox())!;
  expect(resized.width).toBeGreaterThan(initial.width + 100);
  expect(resized.height).toBeGreaterThan(initial.height + 60);
  expect(resized.x + resized.width).toBeLessThanOrEqual(1428);
  expect(resized.y + resized.height).toBeLessThanOrEqual(988);
  await page.reload();
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(resized.width);
  await page.setViewportSize({ width: 800, height: 500 });
  await expect.poll(async () => (await panel.boundingBox())!.height).toBeLessThanOrEqual(476);
  const small = (await panel.boundingBox())!;
  expect(small.x).toBe(252);
  expect(small.y).toBeGreaterThanOrEqual(12);
  expect(small.width).toBeLessThanOrEqual(536);
});

test("many sessions stay reachable without a scrolling header or floating controls", async ({
  page,
}) => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({
    id: `aaaaaaaa-aaaa-aaaa-aaaa-${String(i).padStart(12, "0")}`,
    title:
      i === 0 ? "Plan the release and follow up on every remaining issue" : `Investigation ${i}`,
  }));
  const sockets = new Map<string, import("@playwright/test").WebSocketRoute>();
  await page.route("**/api/optio/sessions", (route) => route.fulfill({ json: { sessions } }));
  await page.routeWebSocket("**/ws/optio/chat*", (ws) => {
    const id = new URL(ws.url()).searchParams.get("sessionId")!;
    sockets.set(id, ws);
    ws.send(JSON.stringify({ type: "history", href: `/work/${id}`, frames: [] }));
    ws.send(JSON.stringify({ type: "status", status: "ready", runtime: "codex" }));
  });
  await page.goto("/work");
  await page.getByRole("button", { name: /Optio Agent/ }).click();
  const panel = page.getByRole("dialog", { name: "Optio assistant" });
  const draft = panel.getByRole("textbox", { name: "Message Optio" });
  await draft.fill("Keep my draft while I find another session");
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 600 });
    const header = panel.getByRole("tabpanel").locator("header");
    await expect(panel.getByRole("tab", { selected: true })).toBeVisible();
    await expect.poll(() => header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const tabs = header.getByRole("tablist");
    await expect.poll(() => tabs.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(48);
    await expect(header.getByRole("button", { name: "All sessions", exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "New agent session" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Minimize Optio" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Open in session" })).toBeVisible();
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  sockets.get(sessions[6].id)!.send(
    JSON.stringify({
      type: "action_proposal",
      actionId: "hidden-approval",
      description: "Review this background action",
      items: ["Start work"],
    }),
  );
  const all = panel.getByRole("button", { name: "All sessions", exact: true });
  await expect(all).toHaveAttribute("aria-description", /approval/);
  await all.click();
  const directory = panel.getByRole("region", { name: "All sessions", exact: true });
  const search = directory.getByRole("textbox", { name: "Find a session" });
  await expect(search).toBeFocused();
  await expect(draft).toBeHidden();
  const background = directory.getByRole("button", { name: "Investigation 6", exact: true });
  await expect(background).toHaveAttribute("aria-description", "Needs approval");
  await search.fill("not a session");
  await expect(directory.getByText(/No sessions match/)).toBeVisible();
  await search.fill("Investigation 11");
  await directory.getByRole("button", { name: "Investigation 11", exact: true }).click();
  const selected = panel.getByRole("tab", { selected: true });
  await expect(selected).toHaveAttribute("aria-label", "Investigation 11");
  await selected.focus();
  await selected.press("ArrowRight");
  await expect(panel.getByRole("tab", { name: sessions[0].title, exact: true })).toBeFocused();
  await expect(draft).toHaveValue("Keep my draft while I find another session");
  await panel.getByRole("button", { name: "Session details", exact: true }).click();
  const details = panel.getByRole("region", { name: "Session details", exact: true });
  await expect(details.getByRole("textbox", { name: "Session name" })).toBeFocused();
  await expect(details.getByRole("button", { name: "Clear conversation" })).toBeEnabled();
  const box = (await details.boundingBox())!,
    bounds = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  await expect(panel.locator("details, [role=menu]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  const detailsButton = panel.getByRole("button", { name: "Session details", exact: true });
  await expect(detailsButton).toBeFocused();
  await expect(draft).toHaveValue("Keep my draft while I find another session");
  await detailsButton.press("Tab");
  await expect(all).toBeFocused();
  await all.press("Shift+Tab");
  await expect(detailsButton).toBeFocused();
});
