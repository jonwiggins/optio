import { describe, expect, it } from "vitest";
import type { ConfigApplyResult } from "@optio/shared";
import { mergeResults, printApplyResult, splitManifests } from "../commands/apply.js";
import { parseKinds } from "../commands/export.js";

const doc = (kind: string, name: string) => ({
  path: `${kind}/${name}.yaml`,
  document: { apiVersion: "optio/v1", kind, metadata: { name }, spec: {} },
});

const summary = (over: Partial<ConfigApplyResult["summary"]> = {}) => ({
  created: 0,
  updated: 0,
  reverted: 0,
  unchanged: 0,
  adopted: 0,
  replaced: 0,
  pruned: 0,
  errors: 0,
  ...over,
});

describe("optio apply with Workspace manifests", () => {
  it("sends Workspace manifests apart from the workspace's resources", () => {
    const split = splitManifests([
      doc("Workspace", "payments"),
      doc("Repo", "acme/api"),
      doc("Workspace", "cards"),
      { path: "empty.yaml", document: null },
    ]);
    expect(split.workspaces.map((m) => m.document)).toEqual([
      doc("Workspace", "payments").document,
      doc("Workspace", "cards").document,
    ]);
    expect(split.resources.map((m) => m.path)).toEqual(["Repo/acme/api.yaml", "empty.yaml"]);
  });

  it("merges both results into one summary", () => {
    const merged = mergeResults([
      {
        dryRun: true,
        items: [{ kind: "Workspace", name: "payments", path: "w.yaml", action: "create" }],
        summary: summary({ created: 1 }),
        at: "2026-01-01T00:00:00.000Z",
      },
      {
        dryRun: true,
        items: [{ kind: "Repo", name: "acme/api", path: "r.yaml", action: "error", message: "x" }],
        summary: summary({ errors: 1 }),
        at: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(merged.items).toHaveLength(2);
    expect(merged.summary).toMatchObject({ created: 1, errors: 1 });
  });

  it("prints a workspace's items under it, in apply order", () => {
    let out = "";
    printApplyResult(
      {
        dryRun: true,
        items: [
          {
            kind: "Workspace",
            name: "payments",
            path: "w.yaml",
            action: "create",
            workspace: "payments",
          },
          {
            kind: "WorkspaceMember",
            name: "lead@bank.example",
            path: "w.yaml",
            action: "create",
            workspace: "payments",
          },
          { kind: "Prompt", name: "p", path: "p.yaml", action: "unchanged" },
        ],
        summary: summary({ created: 2, unchanged: 1 }),
        at: "2026-01-01T00:00:00.000Z",
      },
      (s) => {
        out += s;
        return true;
      },
    );
    const lines = out.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
    expect(lines[0]).toContain("Prompt/p");
    expect(lines[1]).toContain("Workspace/payments");
    expect(lines[2]).toContain("payments: WorkspaceMember/lead@bank.example");
    expect(out).toContain("Plan: 2 created, 1 unchanged");
  });

  it("exports workspaces with --kind workspace", () => {
    expect(parseKinds("workspace")).toEqual(["Workspace"]);
    expect(parseKinds("repo,Workspace")).toEqual(["Repo", "Workspace"]);
    expect(() => parseKinds("team")).toThrow(/Workspace/);
  });
});
