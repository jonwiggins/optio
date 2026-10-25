import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_POLICY_POD_LINES,
  agentPolicyPodLines,
  CLAUDE_POLICY_CLEAR_ENV,
  OPENCODE_POLICY_ENV,
} from "./agent-policy-pod.js";
import { buildEnvExports, buildPooledStartScript, WRITE_SETUP_FILES } from "./pod-env.js";

/** OpenCode's headless block (agent-adapters opencode-headless.ts), as `applyAgentPolicy` sends it. */
const BASE = {
  "*": "allow",
  question: "deny",
  bash: { "sudo *": "deny", "apt *": "deny" },
  external_directory: { "*": "deny" },
};
const DENY = {
  read: { ".env*": "deny", "*.pem": "deny" },
  bash: { "git push --force*": "deny" },
};
const POLICY = JSON.stringify({ base: BASE, deny: DENY });

/** Runs the lines with `env` exported (`set -e`, as the exec scripts do); what OpenCode would get. */
function run(
  env: Record<string, string>,
  claudePath?: string,
): { status: number; config: string; out: string } {
  const script = [
    "set -e",
    ...buildEnvExports(env),
    ...agentPolicyPodLines(claudePath),
    `printf 'CONFIG=%s\\n' "\${OPENCODE_CONFIG_CONTENT:-}"`,
  ].join("\n");
  try {
    const out = execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    return { status: 0, config: out.match(/^CONFIG=(.*)$/m)?.[1] ?? "", out };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, config: "", out: `${e.stdout}${e.stderr}` };
  }
}

describe("the agent policy in the pod: OpenCode", () => {
  it("with no config of the work's own: the headless block, then the deny entries", () => {
    const { status, config } = run({ [OPENCODE_POLICY_ENV]: POLICY });
    expect(status).toBe(0);
    const permission = JSON.parse(config).permission;
    expect(permission).toEqual({
      "*": "allow",
      question: "deny",
      external_directory: { "*": "deny" },
      read: { ".env*": "deny", "*.pem": "deny" },
      bash: { "sudo *": "deny", "apt *": "deny", "git push --force*": "deny" },
    });
    // OpenCode takes the last rule that matches: every denied tool comes after "*".
    expect(Object.keys(permission).at(0)).toBe("*");
  });

  it("keeps the work's own config (a pod secret's provider and model) and adds the rules", () => {
    const own = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://llm.example.test/v1" },
          models: { "qwen-coder": {} },
        },
      },
      model: "local/qwen-coder",
      permission: {
        read: { "*": "allow", ".env*": "allow" },
        bash: "allow",
        webfetch: "deny",
      },
    };
    const { status, config } = run({
      OPENCODE_CONFIG_CONTENT: JSON.stringify(own),
      [OPENCODE_POLICY_ENV]: POLICY,
    });
    expect(status).toBe(0);
    const got = JSON.parse(config);
    expect(got.$schema).toBe(own.$schema);
    expect(got.provider).toEqual(own.provider);
    expect(got.model).toBe("local/qwen-coder");
    // Its own permission over the headless block, the policy last.
    expect(got.permission["*"]).toBe("allow");
    expect(got.permission.question).toBe("deny");
    expect(got.permission.webfetch).toBe("deny");
    expect(got.permission.read).toEqual({ "*": "allow", ".env*": "deny", "*.pem": "deny" });
    // The work allowed .env: the policy's deny now comes after its "*".
    expect(Object.keys(got.permission.read)).toEqual(["*", ".env*", "*.pem"]);
    expect(got.permission.bash).toEqual({ "*": "allow", "git push --force*": "deny" });
    const keys = Object.keys(got.permission);
    expect(keys.indexOf("read")).toBeGreaterThan(keys.indexOf("*"));
    expect(keys.indexOf("bash")).toBeGreaterThan(keys.indexOf("*"));
  });

  it("a permission given as one word becomes the catch-all, under the deny entries", () => {
    const { status, config } = run({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "local/x", permission: "allow" }),
      [OPENCODE_POLICY_ENV]: POLICY,
    });
    expect(status).toBe(0);
    expect(JSON.parse(config)).toEqual({
      model: "local/x",
      permission: {
        "*": "allow",
        read: { ".env*": "deny", "*.pem": "deny" },
        bash: { "git push --force*": "deny" },
      },
    });
  });

  it("stops the run when the work's config isn't a JSON object", () => {
    for (const bad of ["{ // a comment\n }", "[1, 2]", "not json"]) {
      const { status, out } = run({ OPENCODE_CONFIG_CONTENT: bad, [OPENCODE_POLICY_ENV]: POLICY });
      expect(status).not.toBe(0);
      expect(out).toContain("OPENCODE_CONFIG_CONTENT is not a JSON object");
      expect(out).toContain("[optio] ERROR: the agent policy could not be added");
    }
  });

  it("without rules, leaves the work's config exactly as it was", () => {
    const own = '{"model":"local/x",  "provider":{}}';
    expect(run({ OPENCODE_CONFIG_CONTENT: own, [OPENCODE_POLICY_ENV]: "" }).config).toBe(own);
    expect(run({ OPENCODE_CONFIG_CONTENT: own }).config).toBe(own);
    expect(run({}).config).toBe("");
  });
});

describe("the agent policy in the pod: Claude Code with no rules", () => {
  function pod() {
    const dir = join(mkdtempSync(join(tmpdir(), "optio-policy-")), "claude-code");
    mkdirSync(dir);
    const file = join(dir, "managed-settings.json");
    writeFileSync(file, '{"permissions":{"deny":["Read(**/.env*)"]}}');
    writeFileSync(`${file}.optio`, "Written by Optio's agent policy\n");
    return { dir, file };
  }

  it("removes the file an earlier run left in the pod, and its marker", () => {
    const { file } = pod();
    const { status, out } = run({ [CLAUDE_POLICY_CLEAR_ENV]: "1" }, file);
    expect(status).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.optio`)).toBe(false);
    expect(out).toContain("Removed an earlier run's agent policy");
  });

  it("leaves managed settings Optio didn't write (no marker: the image's own)", () => {
    const { file } = pod();
    rmSync(`${file}.optio`);
    const { status, out } = run({ [CLAUDE_POLICY_CLEAR_ENV]: "1" }, file);
    expect(status).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(out).not.toContain("Removed");
  });

  it("leaves it when the run has rules (the setup files just wrote it)", () => {
    const { file } = pod();
    expect(run({ [CLAUDE_POLICY_CLEAR_ENV]: "" }, file).status).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(run({}, file).status).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  it("does nothing, without failing, where the image has no such directory", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "optio-policy-")), "none", "managed.json");
    const { status, out } = run({ [CLAUDE_POLICY_CLEAR_ENV]: "1" }, missing);
    expect(status).toBe(0);
    expect(out).not.toContain("Removed");
  });
});

describe("every exec script runs it", () => {
  it("after the setup files, before the agent", () => {
    expect(WRITE_SETUP_FILES.slice(-AGENT_POLICY_POD_LINES.length)).toEqual([
      ...AGENT_POLICY_POD_LINES,
    ]);
    expect(AGENT_POLICY_POD_LINES.join("\n")).toContain("/etc/claude-code/managed-settings.json");
    const script = buildPooledStartScript({
      env: {},
      runId: "run-1",
      workDir: "/workspace/runs/run-1",
      agentCommand: ["run-agent"],
    });
    const at = script.indexOf(AGENT_POLICY_POD_LINES[0]);
    expect(at).toBeGreaterThan(script.indexOf(WRITE_SETUP_FILES[0]));
    expect(at).toBeLessThan(script.indexOf("run-agent"));
  });
});
