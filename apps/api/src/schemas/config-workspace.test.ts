import { describe, expect, it } from "vitest";
import { WorkspaceManifestSchema, manifestJsonSchema } from "./config.js";

const workspace = (spec: Record<string, unknown>, name = "payments") => ({
  apiVersion: "optio/v1",
  kind: "Workspace",
  metadata: { name },
  spec,
});

describe("Workspace manifest schema", () => {
  it("accepts members, settings, prune and repos", () => {
    const parsed = WorkspaceManifestSchema.safeParse(
      workspace({
        displayName: "Payments",
        settings: { restrictPodSecrets: true, autoJoinRole: "viewer" },
        members: [
          { email: "lead@example.example", role: "admin" },
          { email: "dev@example.example" },
        ],
        prune: true,
        repos: [{ url: "https://github.com/acme/api", defaultBranch: "main", reviewEnabled: true }],
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses an email listed twice, an admin auto-join role, a bad slug and unknown fields", () => {
    const bad = [
      workspace({ members: [{ email: "a@b.example" }, { email: "A@b.example" }] }),
      workspace({ settings: { autoJoinRole: "admin" } }),
      workspace({}, "Payments Team"),
      workspace({ owners: ["a@b.example"] }),
      workspace({ repos: [{ url: "https://github.com/acme/api", slackWebhookUrl: "x" }] }),
    ];
    for (const doc of bad) expect(WorkspaceManifestSchema.safeParse(doc).success).toBe(false);
  });

  it("is part of the served JSON Schema", () => {
    expect(JSON.stringify(manifestJsonSchema())).toContain('"Workspace"');
  });
});
