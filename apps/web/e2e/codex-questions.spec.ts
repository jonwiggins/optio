import { expect, test } from "@playwright/test";
import { codexQuestionReplies, type LocalTranscriptEntry } from "@optio/shared";
import { liveTerminal } from "./fake-daemon";

test("Codex questions offer choices and Other in Chat, and leave Terminal alone", async ({
  page,
  request,
}) => {
  // Includes cold compilation of the work page and two transcript polling rounds.
  test.setTimeout(120_000);
  const session = await liveTerminal(request, { title: "Codex questions", screen: "$ ready\r\n" });
  const entries: LocalTranscriptEntry[] = [
    {
      seq: 1,
      role: "assistant",
      kind: "tool_use",
      text: "Which chat?",
      detail: JSON.stringify({
        questions: [
          { title: "Which chat?", options: ["Work session", "Ask Optio"] },
          { title: "Anything else?", options: ["Nothing else", "Add a note"] },
        ],
      }),
      toolName: "request_user_input_async",
      toolUseId: "call_question",
      isError: false,
      at: new Date().toISOString(),
      source: null,
    },
  ];
  try {
    await page.route(`**/api/local/terminals/${session.id}/transcript*`, async (route) => {
      const after = Number(new URL(route.request().url()).searchParams.get("after") ?? 0);
      await route.fulfill({
        json: { entries: entries.filter((e) => e.seq > after), complete: true },
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/work/${session.id}`);
    await page.getByRole("radio", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("button", { name: "Work session", exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/optio-codex-questions.png" });
    expect(session.input).toEqual([]); // Rendering a question never answers it.
    await page.getByRole("radio", { name: "Terminal", exact: true }).click();
    await expect(page.locator(".local-xterm .xterm-viewport")).toBeVisible();
    await expect(page.getByRole("button", { name: "Work session", exact: true })).toBeHidden();
    await page.getByRole("radio", { name: "Chat", exact: true }).click();

    // Failed delivery leaves the question and draft available to retry.
    let fail = true;
    await page.route(`**/api/local/terminals/${session.id}/input`, async (route) => {
      if (fail) {
        fail = false;
        await route.fulfill({ status: 503, json: { error: "Machine offline" } });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "Work session", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Machine offline" })).toBeVisible();
    await page.getByRole("button", { name: "Work session", exact: true }).click();
    await expect
      .poll(() => session.input.join(""))
      .toContain("</send_user_message_question_reply>\r");
    const first = codexQuestionReplies(session.input.join("").trim())!;
    expect(first).toEqual([
      {
        answer: "Work session",
        question: "Which chat?",
        questionItemId: '["request_user_input_async","call_question",0]',
      },
    ]);
    entries.push({
      ...entries[0]!,
      seq: 2,
      role: "user",
      kind: "text",
      text: session.input.join("").trim(),
      detail: null,
      toolName: null,
      toolUseId: null,
    });
    await expect(page.getByRole("button", { name: "Ask Optio", exact: true })).toBeHidden();
    await expect(page.getByTestId("local-transcript").locator('[data-role="user"]')).toContainText(
      "Work session",
    );
    await expect(page.getByTestId("local-transcript")).not.toContainText(
      "<send_user_message_question_reply>",
    );
    const priorLength = session.input.join("").length;
    const answer = 'Make "Other" work\non a phone 🌱';
    await page.getByRole("button", { name: "Other…", exact: true }).click();
    await page.getByRole("textbox", { name: "Answer: Anything else?" }).fill(answer);
    await page.getByRole("button", { name: "Send answer", exact: true }).click();
    await expect
      .poll(() => session.input.join("").slice(priorLength))
      .toContain("</send_user_message_question_reply>\r");
    expect(codexQuestionReplies(session.input.join("").slice(priorLength).trim())?.[0]).toEqual({
      answer,
      question: "Anything else?",
      questionItemId: '["request_user_input_async","call_question",1]',
    });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await session.done();
  }
});
