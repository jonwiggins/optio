import { describe, it, expect, vi, afterEach } from "vitest";
import type { ContainerSpec, ExecSession } from "@optio/shared";

import { FakeContainerRuntime } from "./fake.js";
import { createRuntime } from "./index.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Command whose join(" ") contains the `--output-format stream-json` marker. */
const AGENT_COMMAND = [
  "bash",
  "-lc",
  "claude -p --input-format stream-json --output-format stream-json --verbose",
];

const UTILITY_COMMAND = ["bash", "-lc", "git worktree prune"];

interface FakeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  message?: { content?: Array<{ type?: string; text?: string }> };
}

function makeSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    image: "optio-agent:latest",
    command: ["/bin/bash", "-c", "sleep infinity"],
    env: {},
    workDir: "/workspace",
    labels: {},
    ...overrides,
  };
}

/** Collect every stdout line until the stream ends. */
function collectLines(stream: NodeJS.ReadableStream): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
    });
    stream.on("end", () => resolve(buf.split("\n").filter((l) => l.length > 0)));
    stream.on("error", reject);
  });
}

/** Parse the JSON lines of the stream, skipping raw (non-JSON) lines. */
function parseEvents(lines: string[]): FakeEvent[] {
  const events: FakeEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as FakeEvent);
    } catch {
      // raw line (e.g. the PR announcement) — not an event
    }
  }
  return events;
}

/** Write the prompt to stdin the way the workers do: a stream-json user message. */
function writePrompt(session: ExecSession, prompt: string): void {
  const msg = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  };
  session.stdin.write(JSON.stringify(msg) + "\n");
}

/** Full agent round-trip: create → exec → send prompt → collect stdout lines. */
async function runAgent(
  runtime: FakeContainerRuntime,
  prompt: string,
  spec: ContainerSpec = makeSpec(),
): Promise<string[]> {
  const handle = await runtime.create(spec);
  const session = await runtime.exec(handle, AGENT_COMMAND);
  const linesPromise = collectLines(session.stdout);
  writePrompt(session, prompt);
  return linesPromise;
}

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("FakeContainerRuntime", () => {
  /* -------------------------------------------------------------- */
  /* lifecycle: create / status / destroy / ping / logs              */
  /* -------------------------------------------------------------- */
  describe("lifecycle", () => {
    it("create returns a fake- handle and uses id as name when spec.name is unset", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());

      expect(handle.id).toMatch(/^fake-[0-9a-f]{12}$/);
      expect(handle.name).toBe(handle.id);
    });

    it("create uses spec.name for the handle name when provided", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec({ name: "repo-pod-0" }));

      expect(handle.name).toBe("repo-pod-0");
    });

    it("status reports running with startedAt for a live handle", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());

      const status = await runtime.status(handle);

      expect(status.state).toBe("running");
      expect(status.startedAt).toBeInstanceOf(Date);
    });

    it("status reports unknown after destroy", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());

      await runtime.destroy(handle);
      const status = await runtime.status(handle);

      expect(status.state).toBe("unknown");
      expect(status.reason).toBe("fake container not found");
    });

    it("status reports unknown for a handle it never created", async () => {
      const runtime = new FakeContainerRuntime();
      const status = await runtime.status({ id: "nope", name: "nope" });

      expect(status.state).toBe("unknown");
    });

    it("ping returns true", async () => {
      const runtime = new FakeContainerRuntime();
      await expect(runtime.ping()).resolves.toBe(true);
    });

    it("logs yields nothing", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());

      const lines: string[] = [];
      for await (const line of runtime.logs(handle)) {
        lines.push(line);
      }

      expect(lines).toEqual([]);
    });
  });

  /* -------------------------------------------------------------- */
  /* utility exec (no stream-json marker)                            */
  /* -------------------------------------------------------------- */
  describe("utility exec", () => {
    it("returns a session whose stdout ends immediately with no data", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());

      const session = await runtime.exec(handle, UTILITY_COMMAND);
      const lines = await collectLines(session.stdout);

      expect(lines).toEqual([]);
    });

    it("accepts stdin writes without erroring", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());

      const session = await runtime.exec(handle, UTILITY_COMMAND);
      const wrote = await new Promise<Error | null | undefined>((resolve) => {
        session.stdin.write("ignored\n", (err) => resolve(err));
      });

      expect(wrote).toBeFalsy();
    });
  });

  /* -------------------------------------------------------------- */
  /* agent exec: default flow                                        */
  /* -------------------------------------------------------------- */
  describe("agent exec (default prompt)", () => {
    it("emits init + assistant + successful result with default cost 0.0123", async () => {
      const runtime = new FakeContainerRuntime();
      const lines = await runAgent(runtime, "Fix the login bug");
      const events = parseEvents(lines);

      expect(events).toHaveLength(3);

      const [init, assistant, result] = events;
      expect(init.type).toBe("system");
      expect(init.subtype).toBe("init");
      expect(init.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      expect(assistant.type).toBe("assistant");
      expect(assistant.session_id).toBe(init.session_id);
      expect(assistant.message?.content?.[0]?.text).toContain("Fix the login bug");

      expect(result.type).toBe("result");
      expect(result.subtype).toBe("success");
      expect(result.is_error).toBe(false);
      expect(result.total_cost_usd).toBe(0.0123);
      expect(result.session_id).toBe(init.session_id);
    });

    it("detects the agent marker across joined command elements", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());

      // The marker only appears once the argv is joined with spaces.
      const session = await runtime.exec(handle, ["claude", "--output-format", "stream-json"]);
      const linesPromise = collectLines(session.stdout);
      writePrompt(session, "hello");

      const events = parseEvents(await linesPromise);
      expect(events.at(-1)?.type).toBe("result");
    });
  });

  /* -------------------------------------------------------------- */
  /* agent exec: directives                                          */
  /* -------------------------------------------------------------- */
  describe("agent exec directives", () => {
    it("[[mock:fail]] produces an is_error result", async () => {
      const runtime = new FakeContainerRuntime();
      const events = parseEvents(await runAgent(runtime, "do the thing [[mock:fail]]"));

      const result = events.at(-1);
      expect(result?.type).toBe("result");
      expect(result?.subtype).toBe("error_during_execution");
      expect(result?.is_error).toBe(true);
      expect(result?.result).toBe("Mock agent failure");
    });

    it("[[mock:silent]] ends the stream with zero events", async () => {
      const runtime = new FakeContainerRuntime();
      const lines = await runAgent(runtime, "[[mock:silent]]");

      expect(lines).toEqual([]);
    });

    it("[[mock:cost:0.5]] reports 0.5 as total_cost_usd", async () => {
      const runtime = new FakeContainerRuntime();
      const events = parseEvents(await runAgent(runtime, "estimate [[mock:cost:0.5]]"));

      const result = events.at(-1);
      expect(result?.is_error).toBe(false);
      expect(result?.total_cost_usd).toBe(0.5);
    });

    it("[[mock:sleep:MS]] still completes with a result", async () => {
      const runtime = new FakeContainerRuntime();
      const events = parseEvents(await runAgent(runtime, "[[mock:sleep:25]]"));

      expect(events.at(-1)?.type).toBe("result");
      expect(events.at(-1)?.is_error).toBe(false);
    });

    it("[[mock:pr]] prints a PR URL derived from the pod's OPTIO_REPO_URL", async () => {
      const runtime = new FakeContainerRuntime();
      const spec = makeSpec({
        env: { OPTIO_REPO_URL: "https://github.com/acme/widgets.git" },
      });
      const lines = await runAgent(runtime, "open a pr [[mock:pr]]", spec);

      // .git suffix is stripped; first PR from this runtime is /pull/1
      const prLine = lines.find((l) => l.includes("/pull/"));
      expect(prLine).toBeDefined();
      expect(prLine).toContain("https://github.com/acme/widgets/pull/1");

      // The PR line is raw output, not a JSON event; the run still succeeds.
      const events = parseEvents(lines);
      expect(events.at(-1)?.type).toBe("result");
      expect(events.at(-1)?.is_error).toBe(false);
    });

    it("[[mock:pr]] increments the PR number per runtime and falls back to mock/repo", async () => {
      const runtime = new FakeContainerRuntime();

      const first = await runAgent(
        runtime,
        "[[mock:pr]]",
        makeSpec({ env: { OPTIO_REPO_URL: "https://github.com/acme/widgets" } }),
      );
      expect(first.some((l) => l.includes("https://github.com/acme/widgets/pull/1"))).toBe(true);

      // No OPTIO_REPO_URL in the spec env → default mock repo, counter at 2.
      const second = await runAgent(runtime, "[[mock:pr]]");
      expect(second.some((l) => l.includes("https://github.com/mock/repo/pull/2"))).toBe(true);
    });
  });

  /* -------------------------------------------------------------- */
  /* prompt-timeout fallback                                         */
  /* -------------------------------------------------------------- */
  describe("prompt timeout", () => {
    it("fails the run loudly when stdin never delivers a prompt", async () => {
      vi.useFakeTimers();

      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());
      const session = await runtime.exec(handle, AGENT_COMMAND);
      const linesPromise = collectLines(session.stdout);

      // Never write to stdin; a missing prompt means the worker's stdin
      // delivery broke — the fake must fail the run, not play success.
      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();

      const events = parseEvents(await linesPromise);
      expect(events.at(-1)?.type).toBe("result");
      expect(events.at(-1)?.is_error).toBe(true);
      expect(String(events.at(-1)?.result)).toContain("no prompt arrived");
    });
  });

  describe("inline prompts (interactive-session chat execs)", () => {
    it("plays the prompt from `claude -p '<prompt>'` without stdin", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());
      const session = await runtime.exec(handle, [
        "bash",
        "-c",
        "claude -p 'Say hi [[mock:cost:0.5]]' --model sonnet --output-format stream-json --verbose",
      ]);
      const events = parseEvents(await collectLines(session.stdout));
      expect(events[0]?.subtype).toBe("init");
      expect(events.at(-1)?.type).toBe("result");
      expect(events.at(-1)?.is_error).toBe(false);
      expect(events.at(-1)?.total_cost_usd).toBe(0.5);
    });
  });

  describe("hang + reaping", () => {
    it("a hanging session is terminated by a kill-style utility exec", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());
      const session = await runtime.exec(handle, AGENT_COMMAND);
      const linesPromise = collectLines(session.stdout);
      writePrompt(session, "Never finish [[mock:hang]]");

      // Give the hang flow a beat to emit init, then reap like the orphan
      // cleanup would: exec a pkill script into the same container.
      await new Promise((r) => setTimeout(r, 50));
      await runtime.exec(handle, ["bash", "-c", "pkill -f 'claude --print' || true"]);

      // The stream must END (not error) so consumers finish normally.
      const events = parseEvents(await linesPromise);
      expect(events[0]?.subtype).toBe("init");
      expect(events.some((e) => e.type === "result")).toBe(false);
    });

    it("destroy() ends live sessions for the container", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());
      const session = await runtime.exec(handle, AGENT_COMMAND);
      const linesPromise = collectLines(session.stdout);
      writePrompt(session, "Never finish [[mock:hang]]");
      await new Promise((r) => setTimeout(r, 50));
      await runtime.destroy(handle);
      await expect(linesPromise).resolves.toBeDefined();
    });

    it("close() ends the streams without erroring consumers", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());
      const session = await runtime.exec(handle, AGENT_COMMAND);
      const linesPromise = collectLines(session.stdout);
      writePrompt(session, "Long sleep [[mock:sleep:60000]]");
      await new Promise((r) => setTimeout(r, 50));
      session.close();
      // End-of-stream, not a stream error — mirrors the k8s exec contract.
      await expect(linesPromise).resolves.toBeDefined();
    });
  });

  describe("directive haystack (repo-task style nesting)", () => {
    it("finds directives buried two base64 levels deep in the exec script", async () => {
      const taskFile = "# Task\n\nDo the thing [[mock:fail]]\n";
      const setupFiles = Buffer.from(
        JSON.stringify([{ path: ".optio/task.md", content: taskFile }]),
      ).toString("base64");
      const envBlob = Buffer.from(
        JSON.stringify({ OPTIO_SETUP_FILES: setupFiles, OPTIO_PROMPT: "rendered template" }),
      ).toString("base64");
      const script = `set -e\nENV_B64='${envBlob}'\n# ... worktree setup ...\nclaude --print --input-format stream-json --output-format stream-json\n`;

      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());
      const session = await runtime.exec(handle, ["bash", "-c", script]);
      const linesPromise = collectLines(session.stdout);
      writePrompt(session, "rendered template with no directives");

      const events = parseEvents(await linesPromise);
      expect(events.at(-1)?.type).toBe("result");
      expect(events.at(-1)?.is_error).toBe(true);
    });
  });

  describe("unsupported agents", () => {
    it("throws loudly for non-claude agent invocations", async () => {
      const runtime = new FakeContainerRuntime();
      const handle = await runtime.create(makeSpec());
      await expect(
        runtime.exec(handle, ["bash", "-c", "echo start && codex exec --json 'do things'"]),
      ).rejects.toThrow(/only plays claude-code/);
    });
  });

  /* -------------------------------------------------------------- */
  /* createRuntime factory                                           */
  /* -------------------------------------------------------------- */
  describe("createRuntime", () => {
    it("returns a FakeContainerRuntime for type fake when acknowledged", () => {
      process.env.OPTIO_ALLOW_FAKE_RUNTIME = "1";
      try {
        const runtime = createRuntime({ type: "fake" });
        expect(runtime).toBeInstanceOf(FakeContainerRuntime);
      } finally {
        delete process.env.OPTIO_ALLOW_FAKE_RUNTIME;
      }
    });

    it("refuses type fake without the explicit acknowledgement", () => {
      delete process.env.OPTIO_ALLOW_FAKE_RUNTIME;
      expect(() => createRuntime({ type: "fake" })).toThrow(/OPTIO_ALLOW_FAKE_RUNTIME/);
    });
  });
});
