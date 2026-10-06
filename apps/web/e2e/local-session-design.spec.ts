import { expect, test } from "@playwright/test";
import { API, liveTerminal } from "./fake-daemon";

// The Local screen has its own header and transcript, separate from pod sessions.
// Exercise that route with a real relay and recorded conversation/usage fixtures.
test("local session controls and usage fit narrow screens, and latest reaches the actual bottom", async ({
  page,
  request,
}) => {
  const session = await liveTerminal(request, {
    title: "Review session recovery on my development machine",
    screen: "$ ready\r\n",
  });
  const record = (await (await request.get(`${API}/api/local/terminals/${session.id}`)).json())
    .terminal;
  const children: string[] = [];
  const entries = Array.from({ length: 24 }, (_, i) => ({
    seq: i + 1,
    role: i % 2 === 0 ? "user" : "assistant",
    kind: "text",
    text:
      i % 2 === 0
        ? `Check recovery case ${i / 2 + 1}.`
        : "The session reconnected to its existing process. Its workspace and earlier output are still available.\n\n- No repeated commands\n- Usage indicators retained",
    detail: null,
    toolName: null,
    toolUseId: null,
    isError: false,
    at: "2026-10-06T12:30:00.000Z",
  }));
  try {
    await page.route(`**/api/local/terminals/${session.id}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.terminal.usage = {
        turns: 12,
        inputTokens: 12000,
        outputTokens: 2400,
        cacheReadTokens: 3000,
        cacheWriteTokens: 0,
        costUsd: 0.42,
        model: "test-model",
      };
      body.terminal.spec = { kind: "agent", agent: "codex" };
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/local/hosts", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const host = body.hosts.find((h: { id: string }) => h.id === record.hostId);
      host.agentLimits = {
        codex: {
          observedAt: new Date().toISOString(),
          planType: "pro",
          primary: { usedPercent: 35, windowMinutes: 300, resetsAt: "2099-01-01T00:00:00Z" },
          secondary: null,
        },
      };
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/local/terminals/*/transcript*", async (route) => {
      const after = Number(new URL(route.request().url()).searchParams.get("after") ?? 0);
      await route.fulfill({
        json: { entries: entries.filter((e) => e.seq > after), complete: true },
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/local/${session.id}`);
    await page.getByRole("radio", { name: "Chat", exact: true }).click();
    const header = page.getByTestId("local-session-header");
    const transcript = page.getByTestId("local-transcript");
    const latest = page.getByRole("button", { name: "Scroll to latest message" });
    await expect(transcript.locator('[data-role="assistant"]')).toHaveCount(12);
    await expect(header.locator('[data-usage-provider="codex"]')).toContainText("35%");
    await transcript.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(latest).toBeVisible();
    await latest.click();
    await expect(latest).toBeHidden();
    await expect
      .poll(() => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThanOrEqual(1);

    for (const width of [320, 390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(header.locator('[data-usage-provider="codex"]')).toBeVisible();
      await expect(
        header.getByRole("button", { name: "Open terminal here", exact: true }),
      ).toBeVisible();
      await expect(header.getByRole("button", { name: "Kill", exact: true })).toBeVisible();
      expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // Keep the header compact without dropping the controls or usage above.
      expect((await header.boundingBox())!.height).toBeLessThan(width === 1440 ? 90 : 130);
      await expect
        .poll(() =>
          page.locator("main").evaluate((el) => ({
            x: el.scrollWidth - el.clientWidth,
            y: el.scrollHeight - el.clientHeight,
          })),
        )
        .toEqual({ x: 0, y: 0 });
      await expect(page.getByPlaceholder("Reply to the agent…")).toBeInViewport();
      const usage = header.locator('[aria-label="Session usage"] > [tabindex="0"]').first();
      await usage.focus();
      const details = page.getByRole("tooltip").filter({ hasText: "This session" });
      await expect(details).toBeVisible();
      const box = (await details.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(details).toBeHidden();
      await header.getByRole("button", { name: "Kill", exact: true }).focus();
    }
    // The redesigned composer still sends exactly once to the real relay.
    await page.getByPlaceholder("Reply to the agent…").fill("Continue with the next check");
    await page.getByPlaceholder("Reply to the agent…").press("Enter");
    await expect.poll(() => session.input.join("")).toBe("Continue with the next check\r");
    await page.getByRole("radio", { name: "Terminal", exact: true }).click();
    await expect(page.locator(".local-xterm .xterm-viewport")).toBeVisible();
    await page.getByRole("radio", { name: "Chat", exact: true }).click();
    await expect(transcript).toBeVisible();

    // Three stacked chats must retain usable content space, not just fit
    // their toolbars inside a phone's viewport.
    for (let i = 0; i < 2; i++) {
      const response = await request.post(`${API}/api/local/terminals`, {
        data: {
          hostId: record.hostId,
          dir: record.dir,
          title: `Related session ${i + 1}`,
          spec: { kind: "shell" },
        },
      });
      expect(response.ok()).toBe(true);
      children.push((await response.json()).terminal.id);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/local/${session.id}?split=${children.join(",")}`);
    await expect(page.getByTestId("local-transcript")).toHaveCount(3);
    for (const pane of await page.locator("[data-session-pane]").all()) {
      await expect(pane.getByTestId("local-chat-composer")).toBeVisible();
      expect((await pane.getByTestId("local-transcript").boundingBox())!.height).toBeGreaterThan(
        40,
      );
      expect(
        await pane.evaluate(
          (el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight,
        ),
      ).toBe(true);
    }
    await page.screenshot({
      path: "/tmp/optio-local-redesign-three-panes.png",
      animations: "disabled",
    });
  } finally {
    for (const id of children) {
      await request.post(`${API}/api/local/terminals/${id}/kill`);
      await expect
        .poll(
          async () =>
            (await (await request.get(`${API}/api/local/terminals/${id}`)).json()).terminal.state,
        )
        .toBe("exited");
      await request.delete(`${API}/api/local/terminals/${id}`);
    }
    await session.done();
  }
});
