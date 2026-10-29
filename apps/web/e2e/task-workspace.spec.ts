import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, fakeDaemon } from "./fake-daemon";

async function localTask(request: APIRequestContext) {
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const host = hosts.find((h: any) => h.name === "E2E laptop");
  const daemon = await fakeDaemon(host.id, host.dirs, { screen: "Training step 3/10\r\n" });
  const response = await request.post(`${API}/api/tasks`, {
    data: {
      type: "repo-task",
      title: "Bounded training and correctness review",
      prompt: "Train for less than an hour, inspect the results, and fix regressions.",
      repoUrl: "https://github.com/e2e-org/e2e-repo",
      repoBranch: "main",
      agentType: "codex",
      runTarget: "local",
      localHostId: host.id,
      localDir: "/Users/e2e/repos/e2e-repo",
      localSessionMode: "interactive",
    },
  });
  expect(response.ok()).toBe(true);
  const { task } = await response.json();
  const getTask = async () =>
    (await (await request.get(`${API}/api/tasks/${task.id}`)).json()).task;
  await expect.poll(async () => (await getTask()).state).toBe("running");
  const terminalId = (await getTask()).localTerminalId as string;
  daemon.send({
    type: "transcript",
    terminalId,
    entries: [
      {
        seq: 1,
        role: "assistant",
        kind: "text",
        text: "The short training run is making progress.",
        detail: null,
        toolName: null,
        toolUseId: null,
        isError: false,
        at: new Date().toISOString(),
      },
    ],
  });
  return {
    task,
    terminalId,
    daemon,
    getTask,
    async done() {
      try {
        await request.post(`${API}/api/tasks/${task.id}/cancel`);
      } finally {
        daemon.close();
      }
    },
  };
}

test("task and Local URLs share live session controls and complete task context on desktop and phone", async ({
  page,
  request,
}) => {
  const run = await localTask(request);
  let childId: string | undefined;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const path of [`/tasks/${run.task.id}`, `/local/${run.terminalId}`]) {
      await page.goto(path);
      await expect(page).toHaveURL(
        new RegExp(`/work/${run.task.id}(\\?session=${run.terminalId})?$`),
      );
      const workspace = page.getByTestId("task-workspace");
      await expect(
        workspace.getByRole("heading", { name: run.task.title, exact: true }),
      ).toBeVisible();
      await expect(
        workspace.locator("header").first().getByText("Running", { exact: true }),
      ).toBeVisible();
      await expect(workspace.getByText("Agent looks stuck", { exact: false })).toHaveCount(0);
      await expect(workspace.getByPlaceholder("Agent is running...")).toHaveCount(0);
      await expect(
        workspace.getByRole("button", { name: "Open terminal here", exact: true }),
      ).toBeVisible();
      await workspace.getByText("Read task instructions", { exact: true }).click();
      await expect(workspace.getByText(run.task.prompt, { exact: true })).toBeVisible();
      await workspace.getByRole("button", { name: "Pipeline", exact: true }).click();
      await expect(workspace.getByText("Raw Events", { exact: false })).toBeVisible();
      await workspace.getByRole("button", { name: "Activity", exact: true }).click();
      await expect(workspace.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
      await workspace.getByRole("button", { name: "Overview", exact: true }).click();
      await workspace.getByRole("radio", { name: "Chat", exact: true }).click();
      await expect(workspace.getByText("The short training run is making progress.")).toBeVisible();
      await expect(workspace.getByTestId("local-chat-composer")).toHaveCount(1);
    }
    await page.getByPlaceholder("Reply to the agent…").fill("Check checkpoint resume too");
    await page
      .getByTestId("local-chat-composer")
      .getByRole("button", { name: "Send", exact: true })
      .click();
    await expect.poll(() => run.daemon.input.join("")).toContain("Check checkpoint resume too\r");
    await page.screenshot({ path: "/tmp/optio-task-workspace-desktop.png" });

    await page.setViewportSize({ width: 390, height: 844 });
    const views = page.getByRole("group", { name: "Session view", exact: true });
    await views.getByRole("button", { name: "Details", exact: true }).click();
    await expect(page.getByText(run.task.prompt, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Dependency", exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/optio-task-workspace-phone-details.png" });
    await views.getByRole("button", { name: "Session", exact: true }).click();
    await expect(page.getByTestId("local-chat-composer")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "/tmp/optio-task-workspace-phone-session.png" });

    await page.setViewportSize({ width: 1440, height: 1000 });
    const created = page.waitForResponse(
      (r) => r.url().endsWith("/api/local/terminals") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Open terminal here", exact: true }).click();
    const child = (await (await created).json()).terminal;
    childId = child.id;
    await expect(page).toHaveURL(new RegExp(`split=${child.id}`));
    await expect(page.locator("[data-session-pane]")).toHaveCount(2);
    await expect(
      page.locator(`[data-session-pane="${run.terminalId}"]`).getByTestId("task-workspace"),
    ).toBeVisible();
    await page
      .locator(`[data-session-pane="${child.id}"]`)
      .getByRole("button", { name: "Close pane", exact: true })
      .click();
    await expect(page.locator("[data-session-pane]")).toHaveCount(1);
    // Old bookmarks retain the exact attempt, split panes, layout, and hash.
    await page.goto(`/local/${run.terminalId}?split=${child.id}&layout=rows#session`);
    await expect(page).toHaveURL(
      new RegExp(
        `/work/${run.task.id}\\?split=${child.id}&layout=rows&session=${run.terminalId}#session$`,
      ),
    );
    await expect(page.locator("[data-session-pane]")).toHaveCount(2);
    await page.reload();
    await expect(page.locator("[data-session-pane]")).toHaveCount(2);
    // Accessible sessions from unrelated work cannot be presented as an attempt of this task.
    await page.goto(`/work/${run.task.id}?session=${child.id}`);
    await expect(
      page.getByText("This session is unavailable or does not belong to this work."),
    ).toBeVisible();
    await expect(page.locator("[data-session-pane]")).toHaveCount(0);
    await page.getByRole("button", { name: "Open current session" }).click();
    await expect(page.locator(`[data-session-pane="${run.terminalId}"]`)).toBeVisible();
    expect((await run.getTask()).state).toBe("running");
  } finally {
    if (childId) {
      await request.post(`${API}/api/local/terminals/${childId}/kill`);
      await expect
        .poll(
          async () =>
            (await (await request.get(`${API}/api/local/terminals/${childId}`)).json()).terminal
              .state,
        )
        .toBe("exited");
      await request.delete(`${API}/api/local/terminals/${childId}`);
    }
    await run.done();
  }
});

test("real Local failures remain visible and old session links keep their original attempt after retry", async ({
  page,
  request,
}) => {
  const run = await localTask(request);
  try {
    run.daemon.send({ type: "exit", terminalId: run.terminalId, exitCode: 1 });
    await expect.poll(async () => (await run.getTask()).state).toBe("failed");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/local/${run.terminalId}`);
    const workspace = page.getByTestId("task-workspace");
    await expect(
      workspace.locator("header").first().getByText("Failed", { exact: true }),
    ).toBeVisible();
    await expect(workspace.getByText("Suggested fix", { exact: true })).toBeVisible();
    await workspace.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(async () => (await run.getTask()).state).toBe("running");
    const currentId = (await run.getTask()).localTerminalId;
    expect(currentId).not.toBe(run.terminalId);
    await expect(
      workspace.getByText("Viewing an earlier session for this task.", { exact: false }),
    ).toBeVisible();
    await expect(workspace.getByRole("link", { name: "Open current session" })).toHaveAttribute(
      "href",
      `/work/${run.task.id}`,
    );
    await expect(workspace.getByTestId("local-chat-composer")).toHaveCount(0);
    await workspace.getByRole("link", { name: "Open current session" }).click();
    await expect(workspace.getByText("Viewing an earlier session", { exact: false })).toHaveCount(
      0,
    );
    await expect(workspace.getByRole("button", { name: "End session", exact: true })).toBeVisible();
    await expect(page).toHaveURL(`/work/${run.task.id}`);
    // Earlier attempts remain accessible in the same page, including after reload.
    await page.getByRole("combobox", { name: "Task session" }).selectOption(run.terminalId);
    await expect(page).toHaveURL(new RegExp(`session=${run.terminalId}`));
    await page.reload();
    await expect(page.locator(`[data-session-pane="${run.terminalId}"]`)).toBeVisible();
    await page.getByRole("combobox", { name: "Task session" }).selectOption("");
    await expect(page.locator(`[data-session-pane="${currentId}"]`)).toBeVisible();
    // An unpinned work URL follows a subsequent retry without changing identity.
    run.daemon.send({ type: "exit", terminalId: currentId, exitCode: 1 });
    await expect.poll(async () => (await run.getTask()).state).toBe("failed");
    await workspace.getByRole("button", { name: "Refresh task" }).click();
    await workspace.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(async () => (await run.getTask()).state).toBe("running");
    const latestId = (await run.getTask()).localTerminalId;
    await expect(page.locator(`[data-session-pane="${latestId}"]`)).toBeVisible();
    await expect(page).toHaveURL(`/work/${run.task.id}`);
  } finally {
    await run.done();
  }
});

test("PR follow-up is presented as attention, while an unavailable task still leaves its Local session accessible", async ({
  page,
  request,
}) => {
  const run = await localTask(request);
  const notices = [
    ["ci_failing_needs_attention", "PR checks need attention."],
    ["pr_conflicts_needs_attention", "PR has merge conflicts."],
    ["review_changes_needs_attention", "PR review requested changes."],
  ];
  let reason = notices[0]![0];
  try {
    // Inject the three real reconciler reasons at the read boundary: no GitHub or CI dependency.
    await page.route(`**/api/tasks/${run.task.id}`, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({
        json: {
          ...data,
          task: {
            ...data.task,
            state: "needs_attention",
            errorMessage: reason,
            prUrl: "https://github.com/e2e-org/e2e-repo/pull/6",
            prNumber: 6,
            prState: "open",
            prs: [
              {
                id: "e2e-pr",
                number: 6,
                url: "https://github.com/e2e-org/e2e-repo/pull/6",
                repoUrl: "https://github.com/e2e-org/e2e-repo",
                headBranch: "optio/task-long-branch-name-for-training-validation",
                state: "open",
                primary: true,
              },
            ],
          },
        },
      });
    });
    for (const [code, title] of notices) {
      reason = code;
      await page.goto(`/local/${run.terminalId}`);
      const workspace = page.getByTestId("task-workspace");
      await expect(workspace.getByText(title!, { exact: true })).toBeVisible();
      await expect(
        workspace.getByRole("link", { name: "Open pull request", exact: true }),
      ).toBeVisible();
      await expect(workspace.getByText("Task failed", { exact: true })).toHaveCount(0);
      await expect(workspace.getByText("Suggested fix", { exact: true })).toHaveCount(0);
      await expect(
        workspace
          .getByRole("region", { name: "Details", exact: true })
          .getByRole("link", { name: "#6", exact: true }),
      ).toBeVisible();
      await workspace.getByRole("button", { name: "Task actions", exact: true }).click();
      await expect(
        page
          .getByRole("dialog", { name: "Task actions" })
          .getByRole("button", { name: "Attempt resume", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close dialog" }).click();
    }
    await page.unroute(`**/api/tasks/${run.task.id}`);
    await page.route(`**/api/tasks/${run.task.id}`, (route) =>
      route.fulfill({ status: 404, json: { error: "Task not found" } }),
    );
    await page.reload();
    await expect(page.getByTestId("local-session-header")).toBeVisible();
    await expect(page.getByTestId("task-workspace")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "End session", exact: true })).toBeVisible();
    await page.route(`**/api/work/${run.task.id}`, (route) =>
      route.fulfill({ status: 404, json: { error: "Work not found" } }),
    );
    await page.reload();
    await expect(page.getByTestId("local-session-header")).toBeVisible();
    await expect(page.getByTestId("task-workspace")).toHaveCount(0);
  } finally {
    await run.done();
  }
});
