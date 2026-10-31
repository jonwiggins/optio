import { describe, expect, it, vi } from "vitest";
import { STANDARD_DENY_RULES, resolveAgentPolicy } from "@optio/shared";

// A database that can't be read: the policy read must not fall back to "no rules".
vi.mock("../db/client.js", () => {
  const fail = () => {
    throw new Error("connection refused");
  };
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "from", "where", "innerJoin"]) chain[k] = () => chain;
  chain.then = (_ok: unknown, bad: (e: unknown) => unknown) => {
    try {
      fail();
    } catch (err) {
      return Promise.reject(err).catch(bad);
    }
  };
  return { db: chain };
});

const { applyAgentPolicy, policyForRuntime, policyChange } = await import("./agent-policy.js");

describe("applyAgentPolicy", () => {
  it("fails the run when the policy can't be read, rather than start it without rules", async () => {
    await expect(
      applyAgentPolicy(
        {
          agentType: "claude-code",
          workspaceId: "00000000-0000-0000-0000-000000000001",
          repoUrl: null,
        },
        [],
        {},
      ),
    ).rejects.toThrow("connection refused");
  });

  it("reads nothing for a command or the assistant", async () => {
    expect(
      await applyAgentPolicy({ agentType: null, workspaceId: "w", repoUrl: null }, [], {}),
    ).toBeNull();
    expect(
      await applyAgentPolicy(
        { agentType: "claude-code", workspaceId: "w", repoUrl: null, controllerOnly: true },
        [],
        {},
      ),
    ).toBeNull();
  });
});

describe("policyForRuntime", () => {
  const policy = resolveAgentPolicy({
    deploymentBuiltIn: true,
    workspace: { denyRules: ["WebFetch(domain:example.com)"] },
  });

  it("says which rules a runtime has no equivalent for", () => {
    const files: never[] = [];
    const env: Record<string, string> = {};
    expect(policyForRuntime(policy, "codex", files, env)).toEqual({
      rules: STANDARD_DENY_RULES.length + 1,
      enforcedBy: null,
      notEnforced: [...STANDARD_DENY_RULES, "WebFetch(domain:example.com)"],
    });
    expect(files).toEqual([]);
    expect(env).toEqual({});
    expect(policyForRuntime(policy, "opencode", [], env).notEnforced).toEqual([
      "WebFetch(domain:example.com)",
    ]);
  });
});

describe("policyChange", () => {
  it("lists the rules added and removed, and the switch when it moved", () => {
    expect(
      policyChange({ denyRules: ["A", "B"] }, { builtInRules: true, denyRules: ["B", "C"] }),
    ).toEqual({ added: ["C"], removed: ["A"], builtInRules: true });
    expect(policyChange(null, {})).toEqual({ added: [], removed: [] });
  });
});
