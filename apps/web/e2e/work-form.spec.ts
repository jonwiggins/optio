/**
 * The New work form, end to end: one draft per storage kind, driven
 * through the real UI against the real API (fake runtime), then the row it
 * created is read back over HTTP and checked for the fields the form
 * promised — the runtime, the prompt, the trigger, the base branch, the
 * title. `deriveKind` is unit-tested; this is the layer where a field can
 * silently fall off between the draft and the request.
 *
 * Seeded by launch-stack.ts: one repo (e2e-org/e2e-repo) and one offline
 * machine ("E2E laptop") with a checkout of it plus a plain directory.
 */
import { expect, test, type Page } from "@playwright/test";

const API = "http://127.0.0.1:4931";

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  // No content-type on a bodiless request — Fastify 400s an empty JSON body.
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A unique name per run so read-backs never hit a row from an earlier run. */
const stamp = Date.now().toString(36);
const named = (what: string) => `E2E ${what} ${stamp}`;

async function open(page: Page) {
  await page.goto("/work/new");
  await expect(page.getByRole("heading", { name: "New work" })).toBeVisible({
    timeout: 30_000,
  });
}

const preset = (page: Page, label: string) =>
  page.getByRole("button", { name: label, exact: true });
const when = (page: Page, label: string) =>
  page.locator("#session-when").getByRole("button", { name: label, exact: true });
const where = (page: Page, title: "Optio pod" | "My machine") =>
  page.locator("#session-where").getByRole("button", { name: title });
const who = (page: Page, label: string) =>
  page.locator("#session-who").getByRole("button", { name: label, exact: true });
// Mode / location cards carry their description in the accessible name.
const then = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(title) });
const prompt = (page: Page) => page.locator("#session-prompt textarea");
const nameInput = (page: Page) => page.locator("#session-name input").first();
const submit = (page: Page) => page.locator('form button[type="submit"]');

async function pickMachine(page: Page, dir: string) {
  await where(page, "My machine").click();
  const machine = page.locator("#session-where select").first();
  await expect(machine).toBeVisible();
  const dirSelect = page.locator("#session-where select").nth(1);
  await dirSelect.selectOption(dir);
}

test.describe("New work form creates every kind", () => {
  test("repo-task: a pod Task that opens a PR carries the runtime, prompt, and title", async ({
    page,
  }) => {
    await open(page);
    await preset(page, "Open a PR").click();
    await who(page, "OpenAI Codex").click();
    await prompt(page).fill("Fix the thing [[mock:pr]]");
    await nameInput(page).fill(named("task"));
    await expect(submit(page)).toHaveText(/Start work \(opens a PR\)/);
    await submit(page).click();
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { task } = await api(`/api/tasks/${id}`);
    expect(task.title).toBe(named("task"));
    expect(task.agentType).toBe("codex");
    expect(task.prompt).toBe("Fix the thing [[mock:pr]]");
    expect(task.repoUrl).toBe("https://github.com/e2e-org/e2e-repo");
  });

  test("repo-blueprint: a scheduled pod Task saves the blueprint and its cron trigger", async ({
    page,
  }) => {
    await open(page);
    await preset(page, "Open a PR").click();
    await when(page, "Schedule").click();
    await prompt(page).fill("Nightly sweep");
    await nameInput(page).fill(named("blueprint"));
    await submit(page).click();
    await expect(page).toHaveURL(/\/tasks\/scheduled\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { task } = await api(`/api/tasks/${id}`);
    expect(task.type).toBe("repo-blueprint");
    expect(task.name).toBe(named("blueprint"));
    const { triggers } = await api(`/api/tasks/${id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("schedule");
    expect(triggers[0].config.cronExpression).toBe("0 9 * * *");
  });

  test("standalone now: a Job with no repo starts a run", async ({ page }) => {
    await open(page);
    await preset(page, "Open a PR").click();
    await page.getByRole("button", { name: "No repo", exact: true }).click();
    await prompt(page).fill("Say hello");
    await nameInput(page).fill(named("job"));
    await expect(submit(page)).toHaveText(/^Start work$/);
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    const [, jobId] = page.url().match(/\/jobs\/([0-9a-f-]{36})\//)!;
    const { workflow } = await api(`/api/jobs/${jobId}`);
    expect(workflow.name).toBe(named("job"));
    expect(workflow.promptTemplate).toBe("Say hello");
  });

  test("standalone + ticket: a Job can be started by tickets, with ticket params in the prompt", async ({
    page,
  }) => {
    await open(page);
    await preset(page, "Scheduled run").click();
    await when(page, "Ticket").click();
    // The param chips insert into the prompt.
    await prompt(page).fill("Triage ");
    await page.getByRole("button", { name: "{{ticketUrl}}" }).click();
    await expect(prompt(page)).toHaveValue("Triage {{ticketUrl}}");
    await nameInput(page).fill(named("ticket job"));
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { triggers } = await api(`/api/jobs/${id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("ticket");
    expect(triggers[0].config.source).toBe("github");
  });

  test("persistent-agent: the agent preset creates a named, addressable agent", async ({
    page,
  }) => {
    await open(page);
    await preset(page, "Persistent agent").click();
    await prompt(page).fill("You are the e2e agent.");
    await nameInput(page).fill(named("agent"));
    await expect(submit(page)).toHaveText(/Create agent/);
    await submit(page).click();
    await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const id = page.url().split("/").pop()!;
    const { agent } = await api(`/api/persistent-agents/${id}`);
    expect(agent.name).toBe(named("agent"));
    expect(agent.slug).toBe(
      named("agent")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-"),
    );
  });

  test("pod-session: waiting for me in a pod keeps the name, and only chats with Claude Code", async ({
    page,
  }) => {
    await open(page);
    await preset(page, "Open a PR").click();
    // Codex can't wait for you in a pod — the card says why.
    await who(page, "OpenAI Codex").click();
    await expect(then(page, "Wait for me")).toBeDisabled();
    await who(page, "Claude Code").click();
    await then(page, "Wait for me").click();
    // The first message is typed in the session, so there is no prompt here.
    await expect(page.locator("#session-prompt")).toHaveCount(0);
    await nameInput(page).fill(named("pod session"));
    await expect(submit(page)).toHaveText(/Open session/);
    await submit(page).click();
    await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const id = page.url().split("/").pop()!;
    const { session } = await api(`/api/sessions/${id}`);
    expect(session.title).toBe(named("pod session"));
    expect(session.repoUrl).toBe("https://github.com/e2e-org/e2e-repo");
  });

  test("local-terminal: an interactive agent on a machine, on a new branch, gets branch instructions", async ({
    page,
  }) => {
    await open(page);
    await preset(page, "Interactive chat").click();
    await pickMachine(page, "/Users/e2e/repos/e2e-repo");
    await page.getByRole("button", { name: "New branch", exact: true }).click();
    await prompt(page).fill("Rename the widget");
    await nameInput(page).fill(named("local chat"));
    await expect(submit(page)).toHaveText(/Open session/);
    await submit(page).click();
    await expect(page).toHaveURL(/\/local\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const id = page.url().split("/").pop()!;
    const { terminal } = await api(`/api/local/terminals/${id}`);
    expect(terminal.title).toBe(named("local chat"));
    expect(terminal.spec.kind).toBe("agent");
    expect(terminal.spec.agent).toBe("claude-code");
    expect(terminal.spec.baseBranch).toBe("main");
    expect(terminal.spec.prompt).toMatch(/^Rename the widget\n\n---\n/);
    expect(terminal.spec.prompt).toContain("open a pull request against `main`");
    // No daemon: it waits for the machine.
    expect(terminal.state).toBe("pending");
  });

  test("repo-blueprint on a machine: a Linear-assigned Task on a new branch keeps the base branch and event filters", async ({
    page,
  }) => {
    await open(page);
    await preset(page, "Open a PR").click();
    await when(page, "Linear").click();
    // Every trigger works with every Where — the pod stays available.
    await expect(where(page, "Optio pod")).toBeEnabled();
    await pickMachine(page, "/Users/e2e/repos/e2e-repo");
    await page.getByRole("button", { name: "New branch", exact: true }).click();
    // "Assigned" is about you, so the login is required before submit.
    await prompt(page).fill("We were assigned {{ticketUrl}}. Triage it.");
    await nameInput(page).fill(named("linear task"));
    await expect(page.getByRole("button", { name: "about you" })).toBeVisible();
    await expect(submit(page)).toBeDisabled();
    await page.getByPlaceholder("Ada Lovelace").fill("@ada");
    await page.getByPlaceholder("ENG, OPS").fill("ENG, ops");
    await expect(submit(page)).toBeEnabled();
    await submit(page).click();
    // A branch that becomes a PR, on a trigger, is a scheduled Task — here one
    // that runs in the machine's checkout.
    await expect(page).toHaveURL(/\/tasks\/scheduled\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { task } = await api(`/api/tasks/${id}`);
    expect(task.type).toBe("repo-blueprint");
    expect(task.name).toBe(named("linear task"));
    expect(task.agentType).toBe("claude-code");
    expect(task.runTarget).toBe("local");
    expect(task.localDir).toBe("/Users/e2e/repos/e2e-repo");
    expect(task.repoBranch).toBe("main");
    expect(task.prompt).toBe("We were assigned {{ticketUrl}}. Triage it.");
    const { triggers } = await api(`/api/tasks/${id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("linear");
    expect(triggers[0].config).toMatchObject({
      events: ["assigned", "mentioned"],
      user: "ada",
      teams: ["ENG", "ops"],
    });
  });

  test("local-blueprint: a GitHub-triggered interactive automation on a machine", async ({
    page,
  }) => {
    await open(page);
    await preset(page, "Interactive chat").click();
    await when(page, "GitHub").click();
    await pickMachine(page, "/Users/e2e/repos/e2e-repo");
    await prompt(page).fill("Review {{url}} with me");
    await nameInput(page).fill(named("github automation"));
    await page.getByPlaceholder("octocat").fill("octocat");
    await expect(submit(page)).toBeEnabled();
    await submit(page).click();
    await expect(page).toHaveURL(/\/local\/automations\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const { blueprints } = await api("/api/local/blueprints");
    const bp = blueprints.find((b: any) => b.name === named("github automation"));
    expect(bp).toBeTruthy();
    expect(bp.agent).toBe("claude-code");
    expect(bp.sessionMode).toBe("interactive");
    expect(bp.commandTemplate).toBe("Review {{url}} with me");
    const { triggers } = await api(`/api/local/blueprints/${bp.id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("github");
    expect(triggers[0].config).toMatchObject({
      events: ["review_requested", "mentioned"],
      login: "octocat",
    });
  });

  test("standalone on a GitHub event: a Job in a pod summarizes every opened PR", async ({
    page,
  }) => {
    await open(page);
    await preset(page, "Scheduled run").click();
    await when(page, "GitHub").click();
    // The pod is the default Where; an event doesn't move it.
    await expect(where(page, "Optio pod")).toBeEnabled();
    // Swap the personal kinds for "any PR opened": no login needed then.
    await page.getByLabel("Review requested from me").uncheck();
    await page.getByLabel("I'm @-mentioned").uncheck();
    await page.getByLabel("Any PR opened").check();
    await page.getByPlaceholder("owner/name, owner/other").fill("e2e-org/e2e-repo");
    await prompt(page).fill("Summarize {{url}}: {{title}}");
    await nameInput(page).fill(named("pr summary job"));
    await expect(submit(page)).toHaveText(/^Save$/);
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { task } = await api(`/api/tasks/${id}`);
    expect(task.type).toBe("standalone");
    expect(task.runTarget).toBe("cluster");
    expect(task.promptTemplate).toBe("Summarize {{url}}: {{title}}");
    const { triggers } = await api(`/api/tasks/${id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("github");
    expect(triggers[0].config).toMatchObject({
      events: ["pr_opened"],
      repos: ["e2e-org/e2e-repo"],
    });
  });

  test("a Slack trigger needs a channel id before the form will submit", async ({ page }) => {
    await open(page);
    await preset(page, "Interactive chat").click();
    await when(page, "Slack").click();
    await pickMachine(page, "/Users/e2e/notes");
    await prompt(page).fill("Reply to {{permalink}}");
    await expect(page.getByRole("button", { name: "in a channel" })).toBeVisible();
    await expect(submit(page)).toBeDisabled();
    await page.getByPlaceholder("C0123ABCD").fill("C0123ABCD");
    await expect(submit(page)).toBeEnabled();
  });
});

/**
 * Editing reopens the same form on saved recurring work: prefilled from
 * the row, kind locked, Save patches the row and its trigger in place.
 */
test.describe("Editing recurring work", () => {
  test("a Job opens from the Recurring view, keeps its kind, and saves prompt + schedule", async ({
    page,
  }) => {
    // Make one through the API so the test owns its row.
    const { task } = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "standalone",
        name: named("editable job"),
        title: named("editable job"),
        prompt: "Before",
        agentType: "claude-code",
        enabled: true,
      }),
    });
    await api(`/api/tasks/${task.id}/triggers`, {
      method: "POST",
      body: JSON.stringify({
        type: "schedule",
        config: { cronExpression: "0 9 * * *" },
        enabled: true,
      }),
    });

    // The Recurring view's row has an Edit action beside it.
    await page.goto("/work?view=recurring");
    await page.getByRole("button", { name: `Edit ${named("editable job")}` }).click();
    await expect(page).toHaveURL(new RegExp(`/work/${task.id}/edit$`), { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Edit work" })).toBeVisible();

    // Prefilled from the row.
    await expect(prompt(page)).toHaveValue("Before");
    await expect(page.locator("#session-when input")).toHaveValue("0 9 * * *");
    await expect(nameInput(page)).toHaveValue(named("editable job"));

    // The kind is locked: a repo would make it a scheduled Task.
    const repoChoice = page.locator("#session-where").getByRole("button", { name: "A repository" });
    await expect(repoChoice).toBeDisabled();
    await expect(repoChoice).toHaveAttribute("title", /saved as a Job/);
    // …but its own attributes are open.
    await expect(when(page, "Webhook")).toBeEnabled();

    await prompt(page).fill("After");
    await page.locator("#session-when").getByRole("button", { name: "Every hour" }).click();
    await submit(page).click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${task.id}$`), { timeout: 30_000 });

    const saved = await api(`/api/tasks/${task.id}`);
    expect(saved.task.promptTemplate).toBe("After");
    const { triggers } = await api(`/api/tasks/${task.id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("schedule");
    expect(triggers[0].config.cronExpression).toBe("0 * * * *");
  });

  test("a Local automation is edited in the form too, not on Machines", async ({ page }) => {
    const { hosts } = await api("/api/local/hosts");
    const host = hosts[0];
    const { blueprint } = await api("/api/local/blueprints", {
      method: "POST",
      body: JSON.stringify({
        name: named("editable automation"),
        hostId: host.id,
        dir: "/Users/e2e/notes",
        commandTemplate: "Reply to {{permalink}}",
        agent: "claude-code",
        sessionMode: "interactive",
      }),
    });
    await api(`/api/local/blueprints/${blueprint.id}/triggers`, {
      method: "POST",
      body: JSON.stringify({
        type: "slack",
        config: { channelId: "C0123ABCD", mentionOnly: true },
        enabled: true,
      }),
    });

    await page.goto(`/work/${blueprint.id}/edit`);
    await expect(page.getByRole("heading", { name: "Edit work" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByPlaceholder("C0123ABCD")).toHaveValue("C0123ABCD");
    await expect(prompt(page)).toHaveValue("Reply to {{permalink}}");

    await page.getByPlaceholder("C0123ABCD").fill("C0999ZZZZ");
    await nameInput(page).fill(named("renamed automation"));
    await submit(page).click();
    // Saving lands on the automation's own page: stats, triggers, runs.
    await expect(page).toHaveURL(new RegExp(`/local/automations/${blueprint.id}$`), {
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: named("renamed automation") })).toBeVisible();
    await expect(page.getByText("C0999ZZZZ")).toBeVisible();

    const after = await api(`/api/local/blueprints/${blueprint.id}`);
    expect(after.blueprint.name).toBe(named("renamed automation"));
    const { triggers } = await api(`/api/local/blueprints/${blueprint.id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].config.channelId).toBe("C0999ZZZZ");
  });
});
