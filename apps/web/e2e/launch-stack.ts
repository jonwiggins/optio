/**
 * Playwright webServer entry: brings up the full deterministic stack for
 * browser e2e — test Postgres/Redis containers, a private database cloned
 * from the migrated template, the REAL API server with the fake container
 * runtime (no cluster, no LLM calls), and `next dev` proxying to it — then
 * seeds enough data that every page renders a non-empty state.
 *
 * Invoked by playwright.config.ts as `tsx e2e/launch-stack.ts`; Playwright
 * waits on the web URL and SIGTERMs this process at teardown (children are
 * killed by the exit handlers below).
 *
 * Fixed ports (chosen to avoid dev defaults): API 4931, web 3131.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import buildTestInfra from "../../api/src/test-utils/integration/global-setup.js";
import { provisionRunInfra } from "../../api/src/test-utils/provision.js";
import { startApiServer } from "../../api/src/test-utils/e2e/api-server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..");
const REPO_ROOT = join(WEB_DIR, "..", "..");

export const API_PORT = 4931;
export const WEB_PORT = 3131;
const API_URL = `http://127.0.0.1:${API_PORT}`;

const children: ChildProcess[] = [];
function killChildren() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
process.on("SIGTERM", () => {
  killChildren();
  process.exit(0);
});
process.on("SIGINT", () => {
  killChildren();
  process.exit(0);
});
process.on("exit", killChildren);

async function provisionDatabase(): Promise<void> {
  // Containers + migrated template + redis-lease sequence. Same global setup
  // the API test tiers use; it resolves OPTIO_TEST_PG_URL / OPTIO_TEST_REDIS_URL
  // into process.env.
  await buildTestInfra();

  const infra = await provisionRunInfra("optio_e2e_run_");
  process.env.DATABASE_URL = infra.testDatabaseUrl;
  process.env.REDIS_URL = infra.testRedisUrl;
  process.env.OPTIO_ENCRYPTION_KEY ??=
    "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988";
  delete process.env.GITHUB_TOKEN;
}

async function api(path: string, body?: unknown, method = "POST"): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function waitTaskState(taskId: string, states: string[], timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await api(`/api/tasks/${taskId}`, undefined, "GET")) as {
      task?: { state: string };
      state?: string;
    };
    const state = body.task?.state ?? body.state;
    if (state && states.includes(state)) return;
    if (Date.now() > deadline) throw new Error(`task ${taskId} never reached ${states.join("|")}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function seed(): Promise<void> {
  // Bypass the setup-wizard gate: GET /api/setup/status requires one git
  // token secret + one agent key secret. Dummy values — nothing validates
  // them and the fake runtime never uses them.
  await api("/api/secrets", { name: "GITHUB_TOKEN", value: "e2e-dummy-git-token" });
  await api("/api/secrets", { name: "ANTHROPIC_API_KEY", value: "e2e-dummy-agent-key" });

  const repo = (await api("/api/repos", {
    repoUrl: "https://github.com/e2e-org/e2e-repo",
    fullName: "e2e-org/e2e-repo",
  })) as { repo: { id: string } };
  void repo;

  // Tasks in a spread of states so /tasks and / render meaningful data.
  const mkTask = async (title: string, prompt: string) =>
    (await api("/api/tasks", {
      title,
      prompt,
      repoUrl: "https://github.com/e2e-org/e2e-repo",
      agentType: "claude-code",
    })) as { task: { id: string } };

  const prTask = await mkTask("E2E: opens a PR", "Open a PR [[mock:pr]]");
  const failTask = await mkTask("E2E: fails", "Fail this run [[mock:fail]]");
  await waitTaskState(prTask.task.id, ["pr_opened"]);
  await waitTaskState(failTask.task.id, ["failed", "queued", "needs_attention"]);

  // A standalone Job with a completed run for /jobs.
  const job = (await api("/api/jobs", {
    name: "E2E seed job",
    promptTemplate: "Say hello from the e2e seed job",
    agentRuntime: "claude-code",
  })) as { workflow: { id: string } };
  const run = (await api(`/api/jobs/${job.workflow.id}/runs`, {})) as { run: { id: string } };
  const deadline = Date.now() + 60_000;
  for (;;) {
    const body = (await api(`/api/workflow-runs/${run.run.id}`, undefined, "GET")) as {
      run: { state: string };
    };
    if (["completed", "failed"].includes(body.run.state)) break;
    if (Date.now() > deadline) throw new Error("seed job run never finished");
    await new Promise((r) => setTimeout(r, 400));
  }

  // A prompt template for /templates and a persistent agent for /agents.
  await api("/api/prompt-templates", {
    name: "E2E seed prompt",
    kind: "prompt",
    template: "Do the thing: {{thing}}",
  });
  await api("/api/persistent-agents", {
    slug: "e2e-seed-agent",
    name: "e2e-seed-agent",
    agentRuntime: "claude-code",
    initialPrompt: "You are the e2e seed agent. Wait for instructions.",
  });
}

async function main(): Promise<void> {
  execFileSync("bash", [join(REPO_ROOT, "scripts", "test-infra.sh"), "start"], {
    stdio: "inherit",
  });
  await provisionDatabase();

  console.warn("[stack] starting API server...");
  const apiServer = await startApiServer({ port: API_PORT, logLevel: "warn" });
  // Register for teardown IMMEDIATELY — if seed() throws, the exit handlers
  // must still find and kill the API server.
  children.push(apiServer.proc);
  console.warn(`[stack] API ready at ${apiServer.baseUrl}`);

  console.warn("[stack] seeding data...");
  await seed();
  console.warn("[stack] seed complete");

  console.warn("[stack] starting next dev...");
  const web = spawn("npx", ["next", "dev", "-p", String(WEB_PORT)], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      INTERNAL_API_URL: API_URL,
      PUBLIC_API_URL: API_URL,
      // Beats the stale apps/web/.env.local value so WebSockets hit our API.
      NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${API_PORT}`,
      OPTIO_AUTH_DISABLED: "true",
    },
    stdio: "inherit",
  });
  children.push(web);

  web.on("exit", (code) => {
    console.error(`[stack] next dev exited (${code})`);
    process.exit(code ?? 1);
  });
  // Keep running until Playwright tears us down.
}

main().catch((err) => {
  console.error("[stack] failed:", err);
  killChildren();
  process.exit(1);
});
