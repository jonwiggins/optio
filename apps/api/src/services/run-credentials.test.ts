import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inserted = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../db/client.js", () => ({
  db: {
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => {
        inserted.push(...rows);
        return Promise.resolve();
      },
    }),
  },
}));

import {
  attributeRunCredentials,
  credentialFingerprint,
  credentialUseCsv,
  noteCredentialUse,
  noteEnvironmentCredential,
  noteSecretUse,
  secretScope,
  withRunCredentials,
  type CredentialUseRow,
} from "./run-credentials.js";

beforeEach(() => vi.stubEnv("OPTIO_RECORD_RUN_CREDENTIALS", "true"));
afterEach(() => {
  inserted.length = 0;
  vi.unstubAllEnvs();
});

const run = { kind: "task" as const, id: "run-1", workspaceId: "ws-1", userId: "u-1" };
const secretRow = (name: string, over: Record<string, unknown> = {}) => ({
  id: `id-${name}`,
  name,
  scope: "global",
  workspaceId: null,
  userId: null,
  ...over,
});

describe("credentialFingerprint", () => {
  it("is keyed by the deployment's encryption key, short, and ignores surrounding whitespace", () => {
    vi.stubEnv("OPTIO_ENCRYPTION_KEY", "a".repeat(64));
    const fp = credentialFingerprint("value-1");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(credentialFingerprint(" value-1\n")).toBe(fp);
    expect(credentialFingerprint("value-2")).not.toBe(fp);
    vi.stubEnv("OPTIO_ENCRYPTION_KEY", "b".repeat(64));
    expect(credentialFingerprint("value-1")).not.toBe(fp);
  });

  it("is null without a key or a value", () => {
    vi.stubEnv("OPTIO_ENCRYPTION_KEY", "");
    expect(credentialFingerprint("value-1")).toBeNull();
    vi.stubEnv("OPTIO_ENCRYPTION_KEY", "a".repeat(64));
    expect(credentialFingerprint("   ")).toBeNull();
  });
});

describe("recording", () => {
  it("classifies what a run reads, skips Optio's own settings, and stores no value", async () => {
    vi.stubEnv("OPTIO_ENCRYPTION_KEY", "a".repeat(64));
    await withRunCredentials(async () => {
      noteSecretUse(secretRow("ANTHROPIC_API_KEY"), "v-anthropic");
      noteSecretUse(secretRow("CLAUDE_AUTH_MODE"), "api-key");
      noteSecretUse(secretRow("GITLAB_HOST"), "gitlab.example.test");
      noteSecretUse(secretRow("GITHUB_USER_ACCESS_TOKEN", { scope: "user:u-1" }), "v-oauth");
      noteSecretUse(
        secretRow("NPM_TOKEN", { scope: "https://github.com/a/b", workspaceId: "ws-1" }),
        "v-npm",
      );
      noteSecretUse(secretRow("MY_CRED", { scope: "user", userId: "u-1" }), "v-mine", {
        agentCredential: true,
      });
      noteEnvironmentCredential("GITLAB_TOKEN", "v-env");
      noteCredentialUse({
        kind: "github-app",
        scope: "deployment",
        name: "GitHub App installation 7",
      });
      attributeRunCredentials({ ...run, repoUrl: "https://github.com/a/b" });
    });
    expect(inserted.map((r) => [r.kind, r.scope, r.name, r.host])).toHaveLength(6);
    expect(inserted.map((r) => [r.kind, r.scope, r.name, r.host])).toEqual(
      expect.arrayContaining([
        ["model-key", "deployment", "ANTHROPIC_API_KEY", null],
        ["git-token", "personal", "GITHUB_USER_ACCESS_TOKEN", "github.com"],
        ["git-token", "environment", "GITLAB_TOKEN", null],
        ["github-app", "deployment", "GitHub App installation 7", "github.com"],
        ["model-key", "personal", "MY_CRED", null],
        ["secret", "repo", "NPM_TOKEN", null],
      ]),
    );
    const stored = JSON.stringify(inserted);
    for (const v of ["v-anthropic", "v-oauth", "v-npm", "v-mine", "v-env"]) {
      expect(stored).not.toContain(v);
    }
    expect(inserted.every((r) => r.runId === "run-1" && r.userId === "u-1")).toBe(true);
  });

  it("does nothing outside a run or when switched off", async () => {
    noteSecretUse(secretRow("ANTHROPIC_API_KEY"), "v");
    vi.stubEnv("OPTIO_RECORD_RUN_CREDENTIALS", "false");
    await withRunCredentials(async () => {
      attributeRunCredentials(run);
      noteSecretUse(secretRow("ANTHROPIC_API_KEY"), "v");
    });
    expect(inserted).toEqual([]);
  });

  it("keeps concurrent runs apart", async () => {
    const one = withRunCredentials(async () => {
      attributeRunCredentials({ ...run, id: "a" });
      await new Promise((r) => setTimeout(r, 5));
      noteSecretUse(secretRow("A_TOKEN"), "va");
    });
    const two = withRunCredentials(async () => {
      attributeRunCredentials({ ...run, id: "b" });
      noteSecretUse(secretRow("B_TOKEN"), "vb");
    });
    await Promise.all([one, two]);
    expect(inserted.map((r) => `${r.runId}:${r.name}`).sort()).toEqual(["a:A_TOKEN", "b:B_TOKEN"]);
  });
});

describe("secretScope", () => {
  it("maps a stored row to who it belongs to", () => {
    expect(secretScope({ scope: "user", workspaceId: null, userId: "u" })).toBe("personal");
    expect(secretScope({ scope: "user:u", workspaceId: null, userId: null })).toBe("personal");
    expect(secretScope({ scope: "global", workspaceId: null, userId: null })).toBe("deployment");
    expect(secretScope({ scope: "global", workspaceId: "w", userId: null })).toBe("workspace");
    expect(secretScope({ scope: "https://x/y", workspaceId: "w", userId: null })).toBe("repo");
  });
});

describe("credentialUseCsv", () => {
  it("quotes every cell and keeps a spreadsheet from running one as a formula", () => {
    const row = {
      usedAt: "2026-11-02T00:00:00.000Z",
      runKind: "task",
      runId: "r",
      workspaceName: '=HYPERLINK("x")',
      workspaceId: null,
      userName: 'Ann "A"',
      userEmail: "+1@example.test",
      userId: null,
      repoUrl: null,
      kind: "secret",
      scope: "repo",
      name: "@NAME",
      credentialId: null,
      host: null,
      fingerprint: "-abc",
    } as unknown as CredentialUseRow;
    const [, line] = credentialUseCsv([row]).split("\r\n");
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain(`"Ann ""A"""`);
    expect(line).toContain(`"'+1@example.test"`);
    expect(line).toContain(`"'@NAME"`);
    expect(line).toContain(`"'-abc"`);
  });
});

describe("every kind of run names itself to the recorder", () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  it.each([
    ["../workers/task-worker.ts", "task"],
    ["../workers/workflow-worker.ts", "job-run"],
    ["../workers/pr-review-worker.ts", "review"],
    ["../workers/persistent-agent-worker.ts", "agent-turn"],
    ["./session-harness-service.ts", "session"],
    ["./interactive-session-service.ts", "session"],
    ["./legacy-session-chat-service.ts", "session"],
  ])("%s records as %s", (file, kind) => {
    const text = src(file);
    expect(text).toContain("attributeRunCredentials(");
    expect(text).toContain(`kind: "${kind}"`);
  });

  it("every worker job runs inside a recorder", () => {
    expect(src("../telemetry/instrument-worker.ts")).toContain(
      "recordingRunCredentials(processor)",
    );
  });
});
