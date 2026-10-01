/**
 * The Chat face's text size and column width controls: A+ grows the
 * conversation's text, "Wider column" widens it, and the choice survives a
 * reload (localStorage). The transcript is served by a route stub; the
 * terminal itself is a live one on the fake daemon.
 */
import { expect, test } from "@playwright/test";
import { liveTerminal } from "./fake-daemon";

const entry = (seq: number, role: string, kind: string, text: string) => ({
  seq,
  role,
  kind,
  text,
  detail: null,
  toolName: null,
  toolUseId: null,
  isError: false,
  at: "2026-10-01T12:00:00.000Z",
});

const ENTRIES = [
  entry(1, "user", "text", "Summarize what changed in the release notes, please."),
  entry(
    2,
    "assistant",
    "text",
    "Here's what changed:\n\n- The **chat view** gained text size controls.\n- Its column can be `narrow`, `medium`, `wide`, or full width.\n\n```\npnpm --filter @optio/web test\n```\n\nThat covers it — a long line of prose here shows how the reading column wraps when its width changes from medium to wide.",
  ),
];

test("A+ grows the chat's text and the width control widens its column", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const terminal = await liveTerminal(request, { title: "chat display e2e" });
  try {
    await page.route("**/api/local/terminals/*/transcript*", async (route) => {
      const after = Number(new URL(route.request().url()).searchParams.get("after") ?? 0);
      await route.fulfill({
        json: { entries: ENTRIES.filter((e) => e.seq > after), complete: true },
      });
    });
    await page.goto(`/local/${terminal.id}`);
    await page.getByRole("radio", { name: "Chat" }).first().click();

    const column = page.getByTestId("local-transcript-column").first();
    const reply = column.locator('[data-role="assistant"] p').first();
    await expect(reply).toContainText("Here's what changed");
    const px = (v: string) => Number.parseFloat(v);
    const fontOf = () => reply.evaluate((el) => getComputedStyle(el).fontSize).then(px);
    const widthOf = async () => (await column.boundingBox())!.width;

    expect(await fontOf()).toBe(13);
    const width0 = await widthOf();

    await page.getByRole("button", { name: "Larger text" }).first().click();
    await page.getByRole("button", { name: "Larger text" }).first().click();
    await expect(page.getByTestId("chat-font-size").first()).toHaveText("15");
    expect(await fontOf()).toBe(15);

    await page.getByRole("button", { name: "Wider column" }).first().click();
    await expect.poll(widthOf).toBeGreaterThan(width0 + 100);

    // Per viewer, persisted: a reload keeps it; Reset puts it back.
    await page.reload();
    await page.getByRole("radio", { name: "Chat" }).first().click();
    await expect(page.getByTestId("chat-font-size").first()).toHaveText("15");
    await page.getByRole("button", { name: "Reset text size and width" }).first().click();
    await expect(page.getByTestId("chat-font-size").first()).toHaveText("13");
    await expect.poll(fontOf).toBe(13);
  } finally {
    await terminal.done();
  }
});
