import { describe, expect, it } from "vitest";
import { ManifestSchema, manifestJsonSchema } from "./config.js";

const work = {
  apiVersion: "optio/v1",
  kind: "Work",
  metadata: { name: "nightly-bump" },
  spec: {
    when: { schedule: "0 3 * * 1-5" },
    where: { repo: "https://github.com/acme/api", branch: "main" },
    who: { runtime: "claude-code", options: { model: "claude-sonnet-4-5" } },
    what: { prompt: "Bump every dependency" },
    then: "until-merged",
    secrets: ["GITHUB_TOKEN"],
    environment: { connections: { add: ["Linear"] }, review: { enabled: true, trigger: "on_pr" } },
  },
};

describe("ManifestSchema", () => {
  it("accepts a Work manifest and each other kind", () => {
    expect(ManifestSchema.safeParse(work).success).toBe(true);
    const ok = (doc: unknown) => expect(ManifestSchema.safeParse(doc).success).toBe(true);
    ok({
      apiVersion: "optio/v1",
      kind: "Prompt",
      metadata: { name: "pr" },
      spec: { template: "Hi" },
    });
    ok({
      apiVersion: "optio/v1",
      kind: "Repo",
      metadata: { name: "acme/api" },
      spec: { url: "https://github.com/acme/api", reviewEnabled: true, maxConcurrentTasks: 2 },
    });
    ok({
      apiVersion: "optio/v1",
      kind: "McpServer",
      metadata: { name: "docs" },
      spec: { command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "${{DOCS_TOKEN}}" } },
    });
    ok({
      apiVersion: "optio/v1",
      kind: "Skill",
      metadata: { name: "notes" },
      spec: { source: { url: "https://github.com/acme/skills", path: "notes" } },
    });
    ok({
      apiVersion: "optio/v1",
      kind: "Connection",
      metadata: { name: "Linear" },
      spec: { provider: "linear", config: { LINEAR_API_KEY: "${{LINEAR_API_KEY}}" } },
    });
  });

  it("takes a `shell` runtime and a promptFile in place of a prompt", () => {
    const shell = {
      ...work,
      spec: { ...work.spec, who: { runtime: "shell" }, what: { promptFile: "./x.sh" } },
    };
    expect(ManifestSchema.safeParse(shell).success).toBe(true);
  });

  it("refuses an unknown kind, an unknown field, a bad `when`, and a missing prompt", () => {
    const bad = (doc: unknown, message: RegExp) => {
      const result = ManifestSchema.safeParse(doc);
      expect(result.success).toBe(false);
      if (!result.success) expect(JSON.stringify(result.error.issues)).toMatch(message);
    };
    bad({ ...work, kind: "Job" }, /Invalid discriminator/);
    bad({ ...work, spec: { ...work.spec, colour: "red" } }, /Unrecognized key/);
    bad(
      { ...work, spec: { ...work.spec, when: { schedule: "* * * * *", webhook: { path: "x" } } } },
      /Unrecognized key|Invalid input/,
    );
    bad({ ...work, spec: { ...work.spec, what: {} } }, /what\.prompt or what\.promptFile/);
    bad(
      {
        apiVersion: "optio/v1",
        kind: "Skill",
        metadata: { name: "s" },
        spec: { prompt: "a", source: { url: "u" } },
      },
      /either a prompt/,
    );
  });

  it("refuses a Repo setting the API doesn't take", () => {
    const result = ManifestSchema.safeParse({
      apiVersion: "optio/v1",
      kind: "Repo",
      metadata: { name: "r" },
      spec: { url: "https://github.com/a/b", slackWebhookUrl: "https://hooks.slack.com/x" },
    });
    expect(result.success).toBe(false);
  });
});

describe("manifestJsonSchema", () => {
  it("is a draft-07 schema that lists every kind", () => {
    const schema = manifestJsonSchema();
    expect(schema.$schema).toContain("draft-07");
    const text = JSON.stringify(schema);
    for (const kind of ["Work", "Prompt", "Repo", "McpServer", "Skill", "Connection"]) {
      expect(text).toContain(`"${kind}"`);
    }
    expect(text).toContain("promptFile");
  });
});
