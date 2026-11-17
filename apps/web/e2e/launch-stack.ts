/**
 * Playwright webServer entry: brings up the full deterministic stack for
 * browser e2e — test Postgres/Redis containers, a private database cloned
 * from the migrated template, the REAL API server with the fake container
 * runtime (no cluster, no LLM calls), and `next dev` proxying to it — then
 * seeds enough data that every page renders a non-empty state.
 *
 * Invoked by playwright.config.ts as `tsx e2e/launch-stack.ts`; Playwright
 * waits on the web URL and, at teardown, SIGTERMs this process group (the
 * config's `gracefulShutdown`). The API runs in its own process group
 * (startApiServer spawns it detached), so shutdown() below stops it
 * explicitly; Playwright's default SIGKILL would skip that and orphan the API
 * on the API port.
 *
 * The API is hermetic (startApiServer's default, see
 * apps/api/src/test-utils/e2e/hermetic-env.ts): it talks to a fake read-only
 * Kubernetes API instead of this machine's kubeconfig — so the cluster pages,
 * shared directories and network policies never reach the real cluster — and
 * sees neither this machine's Claude login nor the shell's credentials.
 *
 * Ports: API 4931, web 3131 by default (chosen to avoid dev defaults); OPTIO_E2E_API_PORT /
 * OPTIO_E2E_WEB_PORT move them, so two stacks can run on one machine (stack-ports.ts).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import buildTestInfra from "../../api/src/test-utils/integration/global-setup.js";
import { provisionRunInfra, type RunInfra } from "../../api/src/test-utils/provision.js";
import { startApiServer, type ApiServerHandle } from "../../api/src/test-utils/e2e/api-server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..");
const REPO_ROOT = join(WEB_DIR, "..", "..");
const nextEnvPath = join(WEB_DIR, "next-env.d.ts");
const nextEnvBefore = readFileSync(nextEnvPath, "utf8").replace(
  "./.next-e2e/types/",
  "./.next/types/",
);

import { API as API_URL, API_PORT, WEB_PORT } from "./stack-ports.js";

let apiServer: ApiServerHandle | null = null;
let web: ChildProcess | null = null;
let infra: RunInfra | null = null;
let stopping = false;

/** Stop next dev, then the API's whole process group, then drop the run database. */
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Next writes its generated route-types reference even with a separate
  // distDir. Restore only our exact change, not edits from a live dev server.
  const testNextEnv = nextEnvBefore.replace("./.next/types/", "./.next-e2e/types/");
  if (readFileSync(nextEnvPath, "utf8") === testNextEnv) {
    writeFileSync(nextEnvPath, nextEnvBefore);
  }
  try {
    web?.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  // SIGTERM to the API's process group, SIGKILL after 10 s.
  await apiServer?.stop().catch(() => {});
  await infra?.drop().catch(() => {});
  process.exit(code);
}
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
process.on("exit", () => {
  // Last resort (e.g. an uncaught throw): never leave the API running.
  const pid = apiServer?.proc.pid;
  if (pid && apiServer?.proc.exitCode === null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  try {
    web?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
});

async function provisionDatabase(): Promise<void> {
  // Containers + migrated template + redis-lease sequence. Same global setup
  // the API test tiers use; it resolves OPTIO_TEST_PG_URL / OPTIO_TEST_REDIS_URL
  // into process.env.
  await buildTestInfra();

  infra = await provisionRunInfra("optio_e2e_run_");
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

  // A named prompt for /templates and a persistent agent for /agents.
  // (POST /api/prompt-templates would overwrite the global default coding
  // prompt that every Repo Task renders; /named creates a Library prompt.)
  await api("/api/prompt-templates/named", {
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

  // A paired (offline) machine with one checkout of the seeded repo, so the
  // New work form can create Local kinds — terminals park in
  // pending/host_offline without a daemon, which is all the form needs.
  await api("/api/local/hosts/register", {
    name: "E2E laptop",
    hostname: "e2e-laptop",
    platform: "darwin",
    dirs: [
      { path: "/Users/e2e/repos/e2e-repo", repoUrl: "https://github.com/e2e-org/e2e-repo" },
      { path: "/Users/e2e/notes" },
    ],
  });
}

async function main(): Promise<void> {
  execFileSync("bash", [join(REPO_ROOT, "scripts", "test-infra.sh"), "start"], {
    stdio: "inherit",
  });
  await provisionDatabase();

  console.warn("[stack] starting API server...");
  // Assigned before anything can throw, so shutdown() and the exit handler
  // always find the API server.
  // Config as code: a directory with one manifest, so Settings → Config as
  // code has a source and the Prompts page a Managed row (config-as-code.spec.ts).
  const configDir = mkdtempSync(join(tmpdir(), "optio-e2e-config-"));
  mkdirSync(join(configDir, "prompts"));
  writeFileSync(
    join(configDir, "prompts", "e2e-managed-prompt.yaml"),
    [
      "apiVersion: optio/v1",
      "kind: Prompt",
      "metadata:",
      "  name: E2E managed prompt",
      "spec:",
      "  template: From the configuration directory {{thing}}",
      "",
    ].join("\n"),
  );
  apiServer = await startApiServer({
    port: API_PORT,
    logLevel: "warn",
    env: {
      OPTIO_CONFIG_DIR: configDir,
      OPTIO_CONFIG_INTERVAL: "15000",
      PUBLIC_URL: `http://127.0.0.1:${WEB_PORT}`,
      PUBLIC_API_URL: API_URL,
    },
  });
  console.warn(`[stack] API ready at ${apiServer.baseUrl}`);

  console.warn("[stack] seeding data...");
  await seed();
  console.warn("[stack] seed complete");

  // CI and check:push (CI=true) build once and serve the build, so no page compiles mid-test
  // (the full suite took 3.7 min instead of 9). Other runs keep `next dev`, which picks up edits.
  // OPTIO_E2E_WEB=production|dev overrides either way.
  const production = process.env.OPTIO_E2E_WEB
    ? process.env.OPTIO_E2E_WEB === "production"
    : Boolean(process.env.CI);
  const webEnv = {
    ...process.env,
    // Separate dirs: a production build and the dev server must not share one.
    OPTIO_NEXT_DIST_DIR: production ? ".next-e2e-prod" : ".next-e2e",
    INTERNAL_API_URL: API_URL,
    PUBLIC_URL: `http://127.0.0.1:${WEB_PORT}`,
    PUBLIC_API_URL: API_URL,
    // Beats the stale apps/web/.env.local value so WebSockets hit our API.
    NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${API_PORT}`,
    // Specs read terminal text off the DOM renderer's rows; the WebGL one
    // draws to a canvas (terminal-render.spec.ts turns it back on).
    NEXT_PUBLIC_OPTIO_TERMINAL_RENDERER: "dom",
    OPTIO_AUTH_DISABLED: "true",
  };
  if (production) {
    console.warn("[stack] building the web app...");
    // next build rewrites these tracked files to point at its dist dir; put them back after,
    // so a test run leaves the checkout as it found it (check:push refuses a run that edits it).
    const restore = ["next-env.d.ts", "tsconfig.json"].map((file) => {
      const path = join(WEB_DIR, file);
      return [path, readFileSync(path, "utf8")] as const;
    });
    // Async, so the API server's piped output keeps draining while the build runs.
    const status = await new Promise<number | null>((done) =>
      spawn("npx", ["next", "build"], {
        cwd: WEB_DIR,
        env: { ...webEnv, NODE_ENV: "production" },
        stdio: "inherit",
      }).on("exit", done),
    );
    for (const [path, text] of restore) writeFileSync(path, text);
    if (status !== 0) throw new Error(`next build failed (${status})`);
  }
  console.warn(`[stack] starting next ${production ? "start" : "dev"}...`);
  web = spawn("npx", ["next", production ? "start" : "dev", "-p", String(WEB_PORT)], {
    cwd: WEB_DIR,
    env: production ? { ...webEnv, NODE_ENV: "production" } : webEnv,
    stdio: "inherit",
  });

  web.on("exit", (code) => {
    if (stopping) return;
    console.error(`[stack] next exited (${code})`);
    void shutdown(code ?? 1);
  });
  // Keep running until Playwright tears us down.
}

main().catch((err) => {
  console.error("[stack] failed:", err);
  void shutdown(1);
});
