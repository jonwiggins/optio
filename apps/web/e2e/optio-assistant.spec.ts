import { expect, test } from "@playwright/test";

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
  await page.routeWebSocket("**/ws/optio/chat", (ws) => {
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
  await page.getByRole("button", { name: /Ask Optio/ }).click();
  const panel = page.getByRole("dialog", { name: "Optio assistant" });
  await expect(panel.getByText("What would you like")).toBeVisible();
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
  await panel.getByRole("button", { name: "Expand panel" }).click();
  await expect(panel).toHaveCSS("width", "720px");
  await page.screenshot({ path: "/tmp/optio-assistant-desktop.png" });
  await panel.getByRole("button", { name: "Minimize Optio" }).click();
  await expect(panel).not.toBeVisible();
  await page.getByRole("button", { name: /Ask Optio/ }).click();
  await expect(panel.getByText("Work created.")).toBeVisible();
});

test("mobile composer fits and the real session restores conversation history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto("/");
  expect(await response!.headerValue("permissions-policy")).toContain("microphone=(self)");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: /Ask Optio/ }).click();
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
  await page.getByRole("button", { name: /Ask Optio/ }).click();
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
  await page.routeWebSocket("**/ws/optio/chat", (ws) => ws.close());
  await page.goto("/");
  await page.getByRole("button", { name: /Ask Optio/ }).click();
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
  await page.routeWebSocket("**/ws/optio/chat", (ws) => ws.close());
  await page.goto("/");
  await page.getByRole("button", { name: /Ask Optio/ }).click();
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
  await page.routeWebSocket("**/ws/optio/chat", (ws) => {
    ws.send(JSON.stringify({ type: "status", status: "ready" }));
  });
  await page.goto("/work");
  const main = page.locator("main");
  const full = (await main.boundingBox())!;
  await page.getByRole("button", { name: /Ask Optio/ }).click();
  const panel = page.getByRole("dialog", { name: "Optio assistant" });
  const draft = panel.getByRole("textbox", { name: "Message Optio" });
  await draft.fill("Keep this draft while I arrange the page");
  expect((await main.boundingBox())!.width).toBe(full.width);
  await panel.getByRole("button", { name: "Dock assistant", exact: true }).click();
  await expect(panel).toHaveCSS("position", "static");
  const docked = (await main.boundingBox())!;
  const assistant = (await panel.boundingBox())!;
  expect(docked.x + docked.width).toBeLessThanOrEqual(assistant.x + 1);
  expect(docked.width).toBeLessThan(full.width - 300);
  await expect(draft).toHaveValue("Keep this draft while I arrange the page");
  await panel.getByRole("button", { name: "Minimize Optio" }).click();
  expect((await main.boundingBox())!.width).toBe(full.width);
  await page.getByRole("button", { name: /Ask Optio/ }).click();
  await expect(panel).toHaveCSS("position", "static");
  await page.reload();
  await page.getByRole("button", { name: /Ask Optio/ }).click();
  await expect(panel).toHaveCSS("position", "static");
  await page.screenshot({ path: "/tmp/optio-assistant-docked.png" });
  await panel.getByRole("button", { name: "Float assistant" }).click();
  await expect(panel).toHaveCSS("position", "fixed");
  expect((await main.boundingBox())!.width).toBe(full.width);
});

test("header, welcome and composer stay separated in short and narrow windows", async ({
  page,
}) => {
  await page.routeWebSocket("**/ws/optio/chat", (ws) => {
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
    await page.getByRole("button", { name: /Ask Optio/ }).click();
    const panel = page.getByRole("dialog", { name: "Optio assistant" });
    await expect(panel.getByRole("heading", { name: "Optio Agent", exact: true })).toBeVisible();
    await expect(panel.getByRole("img", { name: "OpenAI Codex · test-model" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Open in session" })).toBeVisible();
    await expect(panel.getByText("You review actions before Optio runs them.")).toHaveCount(0);
    const emptyComposer = (await panel.getByTestId("optio-composer").boundingBox())!;
    expect(emptyComposer.height).toBeLessThanOrEqual(115);
    const scroll = panel.getByTestId("optio-conversation-scroll");
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(0);
    const header = (await panel.locator("header").boundingBox())!;
    const intro = (await panel.getByText("FROM IDEA TO RUNNING WORK").boundingBox())!;
    expect(intro.y).toBeGreaterThanOrEqual(header.y + header.height);
    const field = panel.getByRole("textbox", { name: "Message Optio" });
    await field.fill("A longer draft\n".repeat(20));
    const input = (await field.boundingBox())!;
    const send = (await panel.getByRole("button", { name: "Send message" }).boundingBox())!;
    expect(send.y).toBeGreaterThanOrEqual(input.y + input.height + 8);
    expect(send.y + send.height).toBeLessThanOrEqual(viewport.height);
    const footer = (await panel.getByTestId("optio-composer").boundingBox())!;
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
    await page.routeWebSocket("**/ws/optio/chat", (ws) => {
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
    await page.getByRole("button", { name: /Ask Optio/ }).click();
    const panel = page.getByRole("dialog", { name: "Optio assistant" });
    await panel.getByRole("textbox", { name: "Message Optio" }).fill("Then check the tests");
    await expect(panel.getByRole("button", { name: "Send message" })).toBeEnabled();
    await panel.getByRole("button", { name: "Send message" }).click();
    const queue = panel.getByRole("region", { name: "Queued messages" });
    await expect(queue.getByText("Then check the tests", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Clear conversation" })).toBeDisabled();
    await queue
      .getByRole("button", { name: "Remove queued message: Then check the tests" })
      .click();
    await expect(queue).toBeHidden();
    expect(received.map((f) => f.type)).toEqual(["message", "cancel_queued"]);
    await panel.getByRole("link", { name: "Optio agent settings" }).click();
    await expect(page).toHaveURL(/\/settings#agents$/);
    await expect(panel).toBeHidden();
    await expect(page.getByRole("group", { name: "Assistant harness" })).toBeVisible();
  },
);
