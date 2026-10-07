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
  // The heading is server-rendered; a click before hydration is lost (an
  // example chip that never applied). The repo picker only renders once the
  // client has fetched the repos.
  await expect(page.locator("#session-where select").first()).toBeVisible({ timeout: 30_000 });
}

async function choosePreset(page: Page, label: string) {
  const examples = page.getByRole("region", { name: "Starting points" });
  if (!(await examples.locator("details").evaluate((el) => (el as HTMLDetailsElement).open))) {
    await examples.locator("summary").click();
  }
  await examples.getByRole("button", { name: label, exact: true }).click();
}
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

/**
 * The writes the page sends to the API ("POST /api/work"), in order. The form
 * creates and saves every kind through `/api/work`; the server writes the
 * row and its trigger together.
 */
function recordWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (req) => {
    const { pathname } = new URL(req.url());
    if (req.method() !== "GET" && pathname.startsWith("/api/")) {
      writes.push(`${req.method()} ${pathname}`);
    }
  });
  return writes;
}
/** Remembering your agent settings is a write of its own, beside the work. */
const workWrites = (writes: string[]) => writes.filter((w) => w !== "PUT /api/me/work-defaults");

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
    await choosePreset(page, "Open a PR");
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
    const writes = recordWrites(page);
    await open(page);
    await choosePreset(page, "Open a PR");
    await when(page, "Schedule").click();
    await prompt(page).fill("Nightly sweep");
    await nameInput(page).fill(named("blueprint"));
    await submit(page).click();
    await expect(page).toHaveURL(/\/tasks\/scheduled\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    // The blueprint and its trigger in one request.
    expect(workWrites(writes)).toEqual(["POST /api/work"]);

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
    await choosePreset(page, "Open a PR");
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
    await choosePreset(page, "Scheduled run");
    await when(page, "Ticket").click();
    // The param chips insert into the prompt.
    await prompt(page).fill("Triage ");
    await page.locator("#session-prompt").getByRole("button", { name: "{{ticketUrl}}" }).click();
    await expect(prompt(page)).toHaveValue("Triage {{ticketUrl}}");
    await nameInput(page).fill(named("ticket job"));
    // Recurring work names each run; the Name section's own chips insert there.
    const runName = page.getByPlaceholder("Triage: {{ticketTitle}}");
    await runName.fill("Triage: ");
    await page.locator("#session-name").getByRole("button", { name: "{{ticketTitle}}" }).click();
    await expect(runName).toHaveValue("Triage: {{ticketTitle}}");
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { triggers } = await api(`/api/jobs/${id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("ticket");
    expect(triggers[0].config.source).toBe("github");
    const { workflow } = await api(`/api/jobs/${id}`);
    expect(workflow.runTitle).toBe("Triage: {{ticketTitle}}");
  });

  test("persistent-agent: the agent preset creates a named, addressable agent", async ({
    page,
  }) => {
    await open(page);
    await choosePreset(page, "Persistent agent");
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

  test("persistent-agent with a repo: it works in a checkout of one of your repos", async ({
    page,
  }) => {
    await open(page);
    await choosePreset(page, "Persistent agent");
    await page.getByRole("button", { name: "A repository", exact: true }).click();
    await prompt(page).fill("Keep the docs in this repo current.");
    await nameInput(page).fill(named("repo agent"));
    await submit(page).click();
    await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const id = page.url().split("/").pop()!;
    const { agent } = await api(`/api/persistent-agents/${id}`);
    expect(agent.repoId).toBeTruthy();
    expect(agent.branch).toBe("main");
  });

  test("standalone command: a Terminal that exits runs a shell command on a schedule", async ({
    page,
  }) => {
    await open(page);
    await choosePreset(page, "Scheduled run");
    await who(page, "Terminal").click();
    // A terminal that exits asks for a command, not a prompt.
    await expect(page.locator("#session-prompt")).toContainText("Command");
    await prompt(page).fill("./scripts/nightly-report.sh");
    await nameInput(page).fill(named("command"));
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const id = page.url().split("/").pop()!;
    const { workflow } = await api(`/api/jobs/${id}`);
    expect(workflow.agentRuntime).toBe("shell");
    expect(workflow.promptTemplate).toBe("./scripts/nightly-report.sh");
  });

  test("pod-session: waiting for me in a pod keeps the name, and only chats with Claude Code", async ({
    page,
  }) => {
    await open(page);
    await choosePreset(page, "Open a PR");
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
    await choosePreset(page, "Interactive chat");
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
    await choosePreset(page, "Open a PR");
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
    await choosePreset(page, "Interactive chat");
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
    await choosePreset(page, "Scheduled run");
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

  test("standalone on PagerDuty incidents: a Job in a pod keeps its kinds, services, and urgency", async ({
    page,
  }) => {
    await open(page);
    await choosePreset(page, "Scheduled run");
    await when(page, "PagerDuty").click();
    await expect(where(page, "Optio pod")).toBeEnabled();
    // "Triggered" is on by default; add "Resolved".
    await expect(page.getByTestId("pagerduty-kind-incident.triggered")).toBeChecked();
    await page.getByTestId("pagerduty-kind-incident.resolved").check();
    await page.getByPlaceholder("Checkout API, PROD1").fill("Checkout API");
    await page
      .getByRole("group", { name: "Urgency" })
      .getByRole("button", { name: "High" })
      .click();
    await prompt(page).fill("Investigate {{title}} on {{service}}: {{url}}");
    await nameInput(page).fill(named("incident job"));
    await expect(submit(page)).toHaveText(/^Save$/);
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { triggers } = await api(`/api/work/${id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("pagerduty");
    expect(triggers[0].config).toEqual({
      events: ["incident.triggered", "incident.resolved"],
      services: ["Checkout API"],
      urgency: "high",
    });
    expect(triggers[0].config.secret).toBeUndefined();
  });

  test("standalone on Pylon events: the secret is shown once, then a delivery starts a run", async ({
    page,
  }) => {
    await open(page);
    await choosePreset(page, "Scheduled run");
    await when(page, "Pylon").click();
    await page.getByTestId("pylon-events").fill("issue.created");
    await prompt(page).fill("Draft a reply to {{title}} from {{account}}");
    await nameInput(page).fill(named("pylon job"));
    await expect(submit(page)).toHaveText(/^Save$/);
    await submit(page).click();

    // The secret dialog, before the page moves on.
    const dialog = page.getByTestId("pylon-secret-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const url = (await dialog.getByText(/\/api\/hooks\/pylon\//).textContent())!.trim();
    expect(url).toMatch(/\/api\/hooks\/pylon\/[0-9a-f-]{36}$/);
    const secret = (await page.getByTestId("pylon-secret-value").textContent())!.trim();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    await page.getByTestId("pylon-secret-done").click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const id = page.url().split("/").pop()!;

    // The job's page says a secret is set and never shows it.
    await page.getByRole("button", { name: /^Triggers/ }).click();
    await expect(page.getByTestId("pylon-secret-state")).toHaveText("Secret set");
    expect(await page.locator("body").textContent()).not.toContain(secret);
    const { triggers } = await api(`/api/work/${id}/triggers`);
    expect(triggers[0].type).toBe("pylon");
    expect(triggers[0].config).toEqual({ events: ["issue.created"], hasSecret: true });

    // A delivery with the secret starts a run; without it, nothing.
    const triggerId = url.split("/").pop()!;
    const deliver = (headers: Record<string, string>) =>
      fetch(`${API}/api/hooks/pylon/${triggerId}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          event: "issue.created",
          issue: { id: "is-1", number: 7, title: "Login broken", account: { name: "Acme" } },
        }),
      });
    expect((await deliver({})).status).toBe(401);
    const accepted = await deliver({ "X-Optio-Secret": secret });
    expect(accepted.status).toBe(202);
    await expect
      .poll(async () => (await api(`/api/jobs/${id}/runs`)).runs.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
  });

  test("standalone on GitLab pipelines: a Job in a pod keeps its kinds, projects, and branches", async ({
    page,
  }) => {
    await open(page);
    await choosePreset(page, "Scheduled run");
    await when(page, "GitLab").click();
    await expect(where(page, "Optio pod")).toBeEnabled();
    // "Review requested" and "mentioned" are on by default (about you): swap
    // them for a repo-wide kind so no username is needed.
    await page.getByTestId("gitlab-kind-review_requested").uncheck();
    await page.getByTestId("gitlab-kind-mentioned").uncheck();
    await page.getByTestId("gitlab-kind-pipeline_failed").check();
    await page.getByTestId("gitlab-projects").fill("e2e-org/e2e-repo");
    await page.getByTestId("gitlab-branches").fill("main, release/*");
    await prompt(page).fill("Fix the pipeline at {{url}} ({{project}} on {{sourceBranch}})");
    await nameInput(page).fill(named("pipeline job"));
    await expect(submit(page)).toHaveText(/^Save$/);
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { triggers } = await api(`/api/work/${id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("gitlab");
    expect(triggers[0].config).toMatchObject({
      events: ["pipeline_failed"],
      projects: ["e2e-org/e2e-repo"],
      branches: ["main", "release/*"],
    });
  });

  test("standalone on Sentry issues: a Job in a pod keeps its kinds, projects, and levels", async ({
    page,
  }) => {
    await open(page);
    await choosePreset(page, "Scheduled run");
    await when(page, "Sentry").click();
    await expect(where(page, "Optio pod")).toBeEnabled();
    // "New issue" is on by default; add "Issue regressed".
    await expect(page.getByTestId("sentry-kind-issue_created")).toBeChecked();
    await page.getByTestId("sentry-kind-issue_unresolved").check();
    await page.getByTestId("sentry-projects").fill("backend");
    await page.getByTestId("sentry-levels").fill("error, fatal");
    await prompt(page).fill("Investigate {{shortId}} in {{project}}: {{title}} — {{url}}");
    await nameInput(page).fill(named("sentry job"));
    await expect(submit(page)).toHaveText(/^Save$/);
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { triggers } = await api(`/api/work/${id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("sentry");
    expect(triggers[0].config).toEqual({
      events: ["issue_created", "issue_unresolved"],
      projects: ["backend"],
      levels: ["error", "fatal"],
    });
    expect(triggers[0].config.secret).toBeUndefined();
  });

  test("standalone on Datadog monitors: the secret is shown once, then a delivery starts a run", async ({
    page,
  }) => {
    await open(page);
    await choosePreset(page, "Scheduled run");
    await when(page, "Datadog").click();
    // "Monitor triggered" is on by default; add "Monitor warning".
    await expect(page.getByTestId("datadog-kind-triggered")).toBeChecked();
    await page.getByTestId("datadog-kind-warning").check();
    await page.getByTestId("datadog-priorities").fill("P1, P2");
    // The payload template to paste into Datadog is right there.
    await expect(page.getByTestId("datadog-payload-template")).toContainText("$ALERT_TRANSITION");
    await prompt(page).fill("Monitor {{title}} is {{transition}} ({{priority}}): {{link}}");
    await nameInput(page).fill(named("datadog job"));
    await expect(submit(page)).toHaveText(/^Save$/);
    await submit(page).click();

    // The secret dialog, before the page moves on.
    const dialog = page.getByTestId("datadog-secret-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const url = (await dialog.getByText(/\/api\/hooks\/datadog\//).textContent())!.trim();
    expect(url).toMatch(/\/api\/hooks\/datadog\/[0-9a-f-]{36}$/);
    const secret = (await page.getByTestId("datadog-secret-value").textContent())!.trim();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    await page.getByTestId("datadog-secret-done").click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const id = page.url().split("/").pop()!;

    // The job's page says a secret is set and never shows it.
    await page.getByRole("button", { name: /^Triggers/ }).click();
    await expect(page.getByTestId("datadog-secret-state")).toHaveText("Secret set");
    expect(await page.locator("body").textContent()).not.toContain(secret);
    const { triggers } = await api(`/api/work/${id}/triggers`);
    expect(triggers[0].type).toBe("datadog");
    expect(triggers[0].config).toEqual({
      events: ["triggered", "warning"],
      priorities: ["P1", "P2"],
      hasSecret: true,
    });

    // A delivery with the secret starts a run; without it, nothing; one
    // the filters don't match (P3) is accepted but starts nothing.
    const triggerId = url.split("/").pop()!;
    const deliver = (headers: Record<string, string>, priority = "P1") =>
      fetch(`${API}/api/hooks/datadog/${triggerId}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          id: "evt-1",
          title: "[Triggered] Checkout latency",
          body: "p95 over 2s",
          alert_transition: "Triggered",
          alert_type: "error",
          priority,
          tags: "service:checkout,env:prod",
          link: "https://app.datadoghq.com/monitors/1",
        }),
      });
    expect((await deliver({})).status).toBe(401);
    const skipped = await deliver({ "X-Optio-Secret": secret }, "P3");
    expect(skipped.status).toBe(202);
    expect((await skipped.json()).runId).toBeUndefined();
    const accepted = await deliver({ "X-Optio-Secret": secret });
    expect(accepted.status).toBe(202);
    await expect
      .poll(async () => (await api(`/api/jobs/${id}/runs`)).runs.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
  });

  test("a Slack trigger needs a channel id before the form will submit", async ({ page }) => {
    await open(page);
    await choosePreset(page, "Interactive chat");
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
 * the row, kind locked, Save patches the row and its trigger in place —
 * one `PATCH /api/work/:id`, whatever the kind.
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
    const writes = recordWrites(page);
    await page.goto("/work?view=recurring");
    await page.getByRole("link", { name: `Edit ${named("editable job")}` }).click();
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
    expect(writes).toEqual([`PATCH /api/work/${task.id}`]);

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

    const writes = recordWrites(page);
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
    expect(writes).toEqual([`PATCH /api/work/${blueprint.id}`]);

    const after = await api(`/api/local/blueprints/${blueprint.id}`);
    expect(after.blueprint.name).toBe(named("renamed automation"));
    const { triggers } = await api(`/api/local/blueprints/${blueprint.id}/triggers`);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].config.channelId).toBe("C0999ZZZZ");
  });
});

test.describe("Remembered agent settings", () => {
  // The e2e stack runs with auth disabled, where the API keeps no per-user
  // settings, so the browser stands in for GET / PUT /api/me/work-defaults
  // with the server's merge rule. What's under test is the form: it saves
  // what was submitted and the next blank form opens with it.
  test("a second New work form opens with the model and effort used last", async ({ page }) => {
    let saved: {
      runtime?: string;
      agentOptions?: Record<string, Record<string, unknown>>;
      location?: { runTarget: string };
    } = {};
    const puts: unknown[] = [];
    await page.route("**/api/me/work-defaults", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        puts.push(body);
        saved = {
          runtime: body.runtime ?? saved.runtime,
          agentOptions: { ...saved.agentOptions, ...body.agentOptions },
          location: body.location ?? saved.location,
        };
      }
      await route.fulfill({ json: { defaults: saved } });
    });

    await open(page);
    await choosePreset(page, "Open a PR");
    await who(page, "Claude Code").click();
    const whoCard = page.locator("#session-who");
    await whoCard.getByLabel("Model").selectOption("claude-sonnet-4-6");
    await whoCard.getByLabel("Effort Level").selectOption("high");
    await prompt(page).fill("Remember me [[mock:pr]]");
    await nameInput(page).fill(named("remembered"));
    await submit(page).click();
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toEqual({
      location: { runTarget: "cluster" },
      runtime: "claude-code",
      agentOptions: {
        "claude-code": expect.objectContaining({
          claudeModel: "claude-sonnet-4-6",
          claudeEffort: "high",
        }),
      },
    });

    await open(page);
    await expect(whoCard.getByLabel("Model")).toHaveValue("claude-sonnet-4-6");
    await expect(whoCard.getByLabel("Effort Level")).toHaveValue("high");
    await expect(page.getByTestId("work-last-settings")).toBeVisible();

    // A stray click on an example chip that sets no options keeps them.
    await choosePreset(page, "Open a PR");
    await expect(whoCard.getByLabel("Model")).toHaveValue("claude-sonnet-4-6");
    await expect(whoCard.getByLabel("Effort Level")).toHaveValue("high");
    await expect(page.getByTestId("work-last-settings")).toBeVisible();

    // Reset goes back to the runtime's defaults for this form (here, the
    // seeded repo's: Opus).
    await page.getByTestId("work-last-settings").getByRole("button", { name: "Reset" }).click();
    await expect(page.getByTestId("work-last-settings")).toHaveCount(0);
    await expect(whoCard.getByLabel("Model")).not.toHaveValue("claude-sonnet-4-6");
  });
});

test.describe("Where → Environment", () => {
  test("environment: a Job leaves out a workspace MCP server and runs its own setup commands", async ({
    page,
  }) => {
    const { server } = await api("/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ name: named("mcp"), command: "e2e-mcp" }),
    });
    await open(page);
    await choosePreset(page, "Scheduled run");
    await prompt(page).fill("Report");
    await nameInput(page).fill(named("env job"));
    await page
      .locator("#session-where")
      .getByRole("button", { name: /^Environment/ })
      .click();
    // A workspace server is on by default — a chip under "Connected to";
    // this work turns it off, and the chip stays, struck through.
    const connected = page.getByTestId("connected-to");
    const chip = connected.getByTestId("connected-chip").filter({ hasText: named("mcp") });
    await expect(chip).toBeVisible();
    await chip.getByRole("button", { name: `Disconnect ${named("mcp")}` }).click();
    await expect(
      connected.getByTestId("connected-chip-off").filter({ hasText: named("mcp") }),
    ).toBeVisible();
    await page.getByLabel("Setup commands").fill("echo ready");
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { work } = await api(`/api/work/${id}`);
    expect(work.settings).toEqual({
      mcpServers: { remove: [server.id] },
      setupCommands: "echo ready",
    });
  });

  test("environment: a pod Task asks for a review as its PR opens, over the repo", async ({
    page,
  }) => {
    await open(page);
    await choosePreset(page, "Open a PR");
    await prompt(page).fill("Fix the flaky test");
    await nameInput(page).fill(named("env task"));
    await page
      .locator("#session-where")
      .getByRole("button", { name: /^Environment/ })
      .click();
    await page.getByRole("button", { name: "Review when the PR opens", exact: true }).click();
    // The plan under Then follows the work's own setting.
    await expect(page.getByText("As soon as the PR opens.")).toBeVisible();
    await submit(page).click();
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    const id = page.url().split("/").pop()!;
    const { work } = await api(`/api/work/${id}`);
    expect(work.settings).toEqual({ review: { enabled: true, trigger: "on_pr" } });
  });
});

/**
 * The Who section's "Signed in with" row: the agent's stored keys and tokens
 * (and Bedrock providers) in one list, `+` to add one. The pick travels as
 * `agentOptions.credential` on the saved row.
 */
test.describe("Signed in with: the agent's credentials", () => {
  test("a stored key is listed, picked, and saved on the Job", async ({ page }) => {
    // Auth is off on the e2e stack, so a "user" secret lands as the organization's.
    await api("/api/secrets", {
      method: "POST",
      body: JSON.stringify({ name: "OPENAI_API_KEY", value: `sk-e2e-${stamp}`, scope: "user" }),
    });
    await open(page);
    await choosePreset(page, "Open a PR");
    await page.getByRole("button", { name: "No repo", exact: true }).click();
    await who(page, "OpenAI Codex").click();
    const { credentials } = await api<{
      credentials: Array<{ id: string; secretName: string | null }>;
    }>("/api/agents/credentials?agentType=codex&owner=workspace");
    const key = credentials.find((c) => c.secretName === "OPENAI_API_KEY");
    expect(key).toBeDefined();
    await page.getByTestId(`credential-${key!.id}`).click();
    await expect(page.getByTestId("credential-row")).toContainText("Signs in with OpenAI API key");
    await prompt(page).fill("Say hello");
    await nameInput(page).fill(named("codex key job"));
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    const [, jobId] = page.url().match(/\/jobs\/([0-9a-f-]{36})\//)!;
    const { workflow } = await api(`/api/jobs/${jobId}`);
    expect(workflow.agentOptions.credential).toBe(key!.id);
    expect(workflow.agentOptions.modelProvider).toBeUndefined();
  });

  test("+ stores a credential through the dialog and picks it", async ({ page }) => {
    await open(page);
    await choosePreset(page, "Open a PR");
    await page.getByRole("button", { name: "No repo", exact: true }).click();
    await who(page, "OpenAI Codex").click();
    await page.getByTestId("credential-add").click();
    await expect(page.getByTestId("credential-dialog")).toBeVisible();
    await page.getByTestId("credential-method-CODEX_APP_SERVER_URL").click();
    await page.getByTestId("credential-value").fill(`http://codex-e2e-${stamp}.local:4000`);
    await page.getByTestId("credential-save").click();
    await expect(page.getByTestId("credential-row")).toContainText(
      "Signs in with Codex app-server",
    );
    await prompt(page).fill("Say hello");
    await nameInput(page).fill(named("codex app-server job"));
    await submit(page).click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    const [, jobId] = page.url().match(/\/jobs\/([0-9a-f-]{36})\//)!;
    const { workflow } = await api(`/api/jobs/${jobId}`);
    expect(workflow.agentOptions.credential).toMatch(/^secret:[0-9a-f-]{36}$/);
  });
});
