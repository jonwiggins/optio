/**
 * Seed inert examples in Docker Desktop Optio, or a private fake-runtime dev lab.
 * node scripts/showcase/seed.mjs --local
 * node scripts/showcase/seed.mjs --lab 4965
 * Only inserts deterministic ids; re-running never overwrites edits or enables work.
 * Local mode creates no credentials, messages, queue jobs, or agent executions.
 * Lab mode adds dummy setup credentials to its isolated fake-runtime API only.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { examples, agents } from "./catalog.mjs";

export const id = (key) => {
  const h = createHash("sha256").update(`optio-showcase-v1:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const local = process.argv[2] === "--local";
const port = local ? 30400 : Number(process.argv[3]);
if (
  !local &&
  (process.argv[2] !== "--lab" || !Number.isInteger(port) || port < 4962 || port > 4979)
) {
  throw new Error("Use --local or --lab <private dev-lab port 4962–4979>");
}
const auth = await fetch(`http://127.0.0.1:${port}/api/auth/me`).then((r) => r.json());
if (!auth.authDisabled) throw new Error("Showcase seeding requires a local auth-disabled instance");
const q = (v) =>
  v === null
    ? "NULL"
    : typeof v === "boolean"
      ? String(v)
      : typeof v === "number"
        ? String(v)
        : `'${(typeof v === "object" ? JSON.stringify(v) : String(v)).replaceAll("'", "''")}'`;
const sql = ["BEGIN;"];
const insert = (table, values, conflict = "id") =>
  sql.push(
    `INSERT INTO ${table} (${Object.keys(values).join(",")}) VALUES (${Object.values(values).map(q).join(",")}) ON CONFLICT (${conflict}) DO NOTHING;`,
  );
const name = (s) => (local ? `Example · ${s}` : s);
const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60000).toISOString();
const repo = local
  ? "https://github.com/jonwiggins/optio"
  : "https://github.com/example/storefront";
const hostId = id("host");
const dir = "/workspace/storefront";
insert("local_hosts", {
  id: hostId,
  name: "Example MacBook",
  hostname: "optio-showcase.example",
  platform: "darwin",
  arch: "arm64",
  dirs: [{ path: dir, repoUrl: repo }],
  state: "offline",
});
if (!local)
  insert("repos", {
    id: id("repo"),
    repo_url: repo,
    full_name: "example/storefront",
    auto_merge: false,
    auto_resume: false,
    review_enabled: false,
    external_review_mode: "off",
  });
for (const [i, e] of examples.entries()) {
  insert("work_definitions", {
    id: id(e.key),
    kind: e.kind,
    name: name(e.name),
    description:
      "Example data. Automatic triggers are disabled. Review the prompt, connections, and destination before enabling. " +
      e.prompt,
    enabled: !local,
    prompt: e.prompt,
    agent_type: e.runtime,
    pod_secrets: [],
    repo_url: e.kind === "repo-blueprint" ? repo : null,
    repo_branch: e.kind === "repo-blueprint" ? "main" : null,
    run_target: e.kind === "local-blueprint" ? "local" : "cluster",
    local_host_id: e.kind === "local-blueprint" ? hostId : null,
    local_dir: e.kind === "local-blueprint" ? dir : null,
    local_session_mode: e.kind === "local-blueprint" ? "interactive" : null,
    spawn_mode: "hold",
    auto_merge: false,
    auto_resume: false,
    max_retries: 0,
    created_at: ago(i + 1),
    updated_at: ago(i + 1),
  });
  insert("workflow_triggers", {
    id: id(`trigger-${e.key}`),
    workflow_id: e.kind === "standalone" ? id(e.key) : null,
    target_type: {
      standalone: "job",
      "repo-blueprint": "task_config",
      "local-blueprint": "local_blueprint",
    }[e.kind],
    target_id: id(e.key),
    type: e.trigger,
    config: e.config,
    enabled: false,
  });
}
for (const a of agents)
  insert("persistent_agents", {
    id: id(a.key),
    name: name(a.name),
    slug: `example-${a.key}`,
    description: "Example data. An on-demand specialist; no messages or turns are queued.",
    agent_runtime: a.runtime,
    initial_prompt: a.prompt,
    system_prompt: a.prompt,
    pod_lifecycle: "on-demand",
    state: local ? "paused" : "idle",
    enabled: !local,
    pod_secrets: [],
  });
// Historical sample output: inserted already completed, never enqueued or run.
const runs = [
  {
    key: "checkout",
    title: "Add keyboard navigation to checkout",
    agent: "claude-code",
    minutes: 18,
    source: "linear",
    summary:
      "Example result: added roving focus, Escape handling, and keyboard tests for the checkout dialog.",
  },
  {
    key: "pagination",
    title: "Replace offset pagination with cursors",
    agent: "codex",
    minutes: 47,
    source: "github",
    summary: "Example result: added cursor pagination with stable ordering and API contract tests.",
  },
  {
    key: "accessibility",
    title: "Audit storefront accessibility",
    agent: "gemini",
    minutes: 100,
    source: null,
    summary:
      "Example result: documented focus order, form labels, contrast, and reduced-motion behavior.",
  },
];
for (const r of runs) {
  insert("tasks", {
    id: id(r.key),
    kind: "repo",
    title: name(r.title),
    prompt: "Example run history, not an actual agent execution. " + r.title,
    repo_url: repo,
    agent_type: r.agent,
    state: "completed",
    result_summary: r.summary,
    ticket_source: r.source,
    metadata: { showcase: true },
    auto_merge: false,
    auto_resume: false,
    pod_secrets: [],
    created_at: ago(r.minutes + 12),
    started_at: ago(r.minutes + 11),
    completed_at: ago(r.minutes),
    updated_at: ago(r.minutes),
    cost_usd: "0",
  });
  for (const [i, content] of [
    "Example transcript · illustrative output, not a production run.",
    "Read the component, API contract, and existing tests before changing behavior.",
    "Implemented the focused change and updated the affected tests.",
    r.summary,
  ].entries())
    insert("task_logs", {
      id: id(`${r.key}-log-${i}`),
      task_id: id(r.key),
      content,
      log_type: "text",
      timestamp: ago(r.minutes + 10 - i * 2),
    });
}
for (const [i, key] of ["morning", "shell", "incident"].entries())
  insert("tasks", {
    id: id(`run-${key}`),
    kind: "standalone",
    work_id: id(key),
    trigger_id: id(`trigger-${key}`),
    title: name(examples.find((e) => e.key === key).name),
    prompt: "Illustrative example history. No external actions were performed.",
    agent_type: examples.find((e) => e.key === key).runtime,
    state: "completed",
    result_summary:
      "Example output: the report is ready for review. No external changes were made.",
    output: { summary: "Sample report ready for review" },
    metadata: { showcase: true },
    pod_secrets: [],
    created_at: ago(35 + i * 20),
    started_at: ago(34 + i * 20),
    completed_at: ago(30 + i * 20),
    updated_at: ago(30 + i * 20),
    cost_usd: "0",
  });
// Recorded sessions render through the same transcript and terminal paths as real sessions.
const terminals = [
  {
    key: "session-claude",
    title: "Polish the checkout experience",
    runtime: "claude-code",
    prompt: "Make checkout easier to use from the keyboard. Keep the existing payment flow intact.",
    answer:
      "## Ready for your review\n\nThe checkout dialog now keeps focus inside the form and returns it to the trigger when it closes.\n\n- Added **Escape** to dismiss and clear field labels.\n- Preserved the existing payment and validation flow.\n- Added keyboard navigation coverage.\n\nThe example change is ready for a person to review before opening a PR.",
  },
  {
    key: "session-codex",
    title: "Build a faster product search",
    runtime: "codex",
    prompt: "Improve search responsiveness without changing the public API.",
    answer:
      "## Search feels faster\n\nThe example implementation debounces requests, cancels stale responses, and keeps the last results visible while loading.\n\n- Kept the existing API response shape.\n- Added empty, loading, and error states.\n- Covered out-of-order responses with a focused test.\n\nReview the changes and decide whether to publish.",
  },
  {
    key: "session-terminal",
    title: "Storefront smoke checks",
    runtime: null,
    prompt: "Run the example smoke checks.",
    answer: "Example smoke checks complete.",
  },
];
for (const [i, t] of terminals.entries()) {
  const terminalId = id(t.key);
  insert("local_terminals", {
    id: terminalId,
    host_id: hostId,
    title: name(t.title),
    dir,
    spec: t.runtime
      ? { kind: "agent", agent: t.runtime, mode: "interactive", prompt: t.prompt }
      : { kind: "shell" },
    state: "exited",
    exit_code: 0,
    attention_state: "idle",
    preview: t.answer.split("\n")[0].replace(/^## /, ""),
    spawned_by: i === 0 ? "trigger" : "manual",
    trigger_id: i === 0 ? id("trigger-local") : null,
    blueprint_id: i === 0 ? id("local") : null,
    created_at: ago(8 + i),
    started_at: ago(7 + i),
    ended_at: ago(1 + i),
    last_activity_at: ago(1 + i),
  });
  if (t.runtime)
    for (const [seq, role, text] of [
      [1, "user", t.prompt],
      [2, "assistant", "I’ll inspect the current behavior and keep the change focused."],
      [3, "assistant", t.answer],
    ])
      insert(
        "local_terminal_transcripts",
        { terminal_id: terminalId, seq, role, kind: "text", text, at: ago(6 + i - seq) },
        "terminal_id,seq",
      );
  const lines = t.runtime
    ? [
        `\x1b[1m${t.runtime === "codex" ? "OpenAI Codex" : "Claude Code"}\x1b[0m  ·  storefront`,
        "\x1b[2mExample session · recorded demonstration\x1b[0m",
        "",
        `› ${t.prompt}`,
        "",
        "\x1b[32m✓\x1b[0m Read existing components and tests",
        "\x1b[32m✓\x1b[0m Implemented a focused change",
        "\x1b[32m✓\x1b[0m Added regression coverage",
        "",
        ...t.answer.replaceAll("**", "").replace("## ", "").split("\n"),
      ]
    : [
        "\x1b[1mStorefront · smoke checks\x1b[0m",
        "\x1b[2mExample terminal · recorded demonstration\x1b[0m",
        "",
        "$ pnpm test:smoke",
        "",
        "\x1b[32m✓\x1b[0m Product catalog loads",
        "\x1b[32m✓\x1b[0m Search preserves query state",
        "\x1b[32m✓\x1b[0m Checkout supports keyboard navigation",
        "\x1b[32m✓\x1b[0m API health check passes",
        "",
        "4 checks passed · no external changes",
        "",
        "$",
      ];
  const screen = "\x1b[2J\x1b[H" + lines.join("\r\n") + "\r\n";
  sql.push(
    `INSERT INTO local_terminal_snapshots (terminal_id,data,cols,rows) VALUES (${q(terminalId)},decode(${q(Buffer.from(screen).toString("hex"))},'hex'),100,32) ON CONFLICT (terminal_id) DO NOTHING;`,
  );
}
sql.push("COMMIT;");
let command, args;
if (local) {
  command = "kubectl";
  args = [
    "--context",
    "docker-desktop",
    "-n",
    "optio",
    "exec",
    "-i",
    "deployment/optio-postgres",
    "--",
    "psql",
    "-U",
    "optio",
    "-d",
    "optio",
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
  ];
} else {
  const state = JSON.parse(readFileSync(`apps/android/e2e/.run/${port}/server.json`, "utf8"));
  if (!/^optio_e2e_run_\d+_[a-f0-9]+$/.test(state.dbName))
    throw new Error("Not a private dev-lab database");
  command = "docker";
  args = [
    "exec",
    "-i",
    "optio-test-postgres",
    "psql",
    "-U",
    "optio_test",
    "-d",
    state.dbName,
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
  ];
}
execFileSync(command, args, { input: sql.join("\n"), stdio: ["pipe", "pipe", "pipe"] });
// The fresh lab needs dummy keys to pass its setup gate. Never touch local credentials.
if (!local) {
  const base = `http://127.0.0.1:${port}`;
  const existingResponse = await fetch(`${base}/api/secrets`);
  if (!existingResponse.ok) throw new Error("Could not read lab setup state");
  const existing = await existingResponse.json();
  for (const secretName of ["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]) {
    if ((existing.secrets ?? []).some((s) => s.name === secretName)) continue;
    const response = await fetch(`${base}/api/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: secretName, value: "optio-showcase-dummy-not-a-credential" }),
    });
    if (!response.ok) throw new Error(`Lab setup failed: ${response.status}`);
  }
}
const manifest = {
  api: `http://127.0.0.1:${port}`,
  examples: Object.fromEntries(examples.map((e) => [e.key, id(e.key)])),
  agents: Object.fromEntries(agents.map((a) => [a.key, id(a.key)])),
  tasks: Object.fromEntries(runs.map((r) => [r.key, id(r.key)])),
  terminals: Object.fromEntries(terminals.map((t) => [t.key, id(t.key)])),
  hostId,
};
// Keep a running capture's session ids when the catalog is seeded again.
try {
  const previous = JSON.parse(readFileSync(`/tmp/optio-showcase-${port}.json`, "utf8"));
  if (previous.live) {
    const { terminals } = await fetch(`${manifest.api}/api/local/terminals`).then((r) => r.json());
    if (
      Object.values(previous.live).every((liveId) =>
        terminals.some((t) => t.id === liveId && t.state === "running"),
      )
    )
      manifest.live = previous.live;
  }
} catch {
  /* A first seed has no prior manifest. */
}
writeFileSync(`/tmp/optio-showcase-${port}.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Seeded ${examples.length} definitions, ${agents.length} agents, 6 historical runs and 3 recorded sessions. All triggers disabled. ${local ? "Local examples paused." : "Isolated demo data ready."}`,
);
