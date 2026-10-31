import { describe, expect, it } from "vitest";
import { classifyError } from "./error-classifier.js";
import {
  AgentPolicyError,
  STANDARD_DENY_RULES,
  claudeManagedSettings,
  cleanAgentPolicy,
  denyRuleError,
  opencodeDenyPermission,
  opencodePathPatterns,
  opencodeSupportsRule,
  resolveAgentPolicy,
  runtimeClassNameError,
} from "./agent-policy.js";

describe("resolveAgentPolicy", () => {
  it("has no rules with nothing set (the default)", () => {
    expect(resolveAgentPolicy({ deploymentBuiltIn: false })).toEqual({
      builtInRules: false,
      builtInFrom: null,
      rules: [],
    });
  });

  it("adds the built-in rules when the deployment turns them on", () => {
    const p = resolveAgentPolicy({ deploymentBuiltIn: true });
    expect(p.builtInFrom).toBe("deployment");
    expect(p.rules.map((r) => r.rule)).toEqual([...STANDARD_DENY_RULES]);
    expect(p.rules.every((r) => r.from === "built-in")).toBe(true);
  });

  it("lets a workspace turn the built-in rules on, but not off over the deployment", () => {
    const on = resolveAgentPolicy({ deploymentBuiltIn: false, workspace: { builtInRules: true } });
    expect(on.builtInFrom).toBe("workspace");
    expect(on.rules).toHaveLength(STANDARD_DENY_RULES.length);
    const off = resolveAgentPolicy({
      deploymentBuiltIn: true,
      workspace: { builtInRules: false },
    });
    expect(off.builtInFrom).toBe("deployment");
    expect(off.rules).toHaveLength(STANDARD_DENY_RULES.length);
  });

  it("adds the workspace's and the repo's rules in that order, each once", () => {
    const p = resolveAgentPolicy({
      deploymentBuiltIn: false,
      workspace: { denyRules: ["Read(**/secrets/**)", "Bash(terraform apply*)"] },
      repo: { denyRules: ["Bash(terraform apply*)", "Read(**/fixtures/prod.json)"] },
    });
    expect(p.rules).toEqual([
      { rule: "Read(**/secrets/**)", from: "workspace" },
      { rule: "Bash(terraform apply*)", from: "workspace" },
      { rule: "Read(**/fixtures/prod.json)", from: "repo" },
    ]);
  });

  it("keeps a built-in rule a lower level repeats as the built-in one", () => {
    const p = resolveAgentPolicy({
      deploymentBuiltIn: true,
      repo: { denyRules: ["Read(**/*.pem)"] },
    });
    expect(p.rules.filter((r) => r.rule === "Read(**/*.pem)")).toEqual([
      { rule: "Read(**/*.pem)", from: "built-in" },
    ]);
  });

  it("skips what a stored level holds that isn't a rule", () => {
    const p = resolveAgentPolicy({
      deploymentBuiltIn: false,
      workspace: { denyRules: [42 as unknown as string, " ", "Bash(x)", "Read("] },
      repo: { denyRules: "Read(x)" as unknown as string[] },
    });
    expect(p.rules).toEqual([{ rule: "Bash(x)", from: "workspace" }]);
  });
});

describe("claudeManagedSettings", () => {
  it("writes the rules as permissions.deny and nothing else", () => {
    const settings = claudeManagedSettings(["Read(**/.env*)", "Bash(git push --force *)"]);
    expect(settings).toEqual({
      permissions: { deny: ["Read(**/.env*)", "Bash(git push --force *)"] },
    });
  });
});

describe("cleanAgentPolicy", () => {
  it("trims, drops blanks and repeats, and keeps only the level's fields", () => {
    expect(
      cleanAgentPolicy(
        { builtInRules: true, denyRules: [" Bash(x) ", "", "Bash(x)", "Read(y)"] },
        "workspace",
      ),
    ).toEqual({ builtInRules: true, denyRules: ["Bash(x)", "Read(y)"] });
    expect(cleanAgentPolicy({ builtInRules: true, denyRules: ["Bash(x)"] }, "repo")).toEqual({
      denyRules: ["Bash(x)"],
    });
    expect(cleanAgentPolicy({ builtInRules: false }, "workspace")).toEqual({});
  });

  it("is an empty object, not null, when nothing is left", () => {
    expect(cleanAgentPolicy({ denyRules: [" "] }, "repo")).toEqual({});
  });

  it("refuses a malformed rule, naming each", () => {
    expect(() =>
      cleanAgentPolicy({ denyRules: ["Read(", "Bash()", "read secrets please"] }, "repo"),
    ).toThrow(AgentPolicyError);
    try {
      cleanAgentPolicy({ denyRules: ["Read(", "Bash()"] }, "repo");
    } catch (err) {
      expect((err as Error).message).toContain('"Read("');
      expect((err as Error).message).toContain('"Bash()" has nothing between the brackets');
    }
  });

  it("refuses more than 100 rules", () => {
    const many = Array.from({ length: 101 }, (_, i) => `Bash(cmd${i})`);
    expect(() => cleanAgentPolicy({ denyRules: many }, "workspace")).toThrow("At most 100 rules");
  });
});

describe("rule and name checks", () => {
  it("accepts Claude Code's rule shapes", () => {
    for (const r of [
      "Bash",
      "Read(**/.env*)",
      "Edit(//etc/claude-code/**)",
      "Bash(npm run test:*)",
      "WebFetch(domain:example.com)",
      "mcp__github__create_issue",
    ]) {
      expect(denyRuleError(r), r).toBeNull();
    }
    expect(denyRuleError("Bash(\nrm)")).toContain("line break");
    expect(denyRuleError("Bash(\u0007)")).toContain("control character");
    expect(denyRuleError("x".repeat(301))).toContain("longer than");
  });

  it("checks RuntimeClass names as DNS subdomains", () => {
    expect(runtimeClassNameError("gvisor")).toBeNull();
    expect(runtimeClassNameError("kata-qemu.v2")).toBeNull();
    for (const bad of ["-x", "Gvisor", "a b", "x".repeat(254), "", "a_b"]) {
      expect(runtimeClassNameError(bad), bad).not.toBeNull();
    }
  });
});

describe("OpenCode's equivalent", () => {
  it("translates path patterns, never narrower than Claude Code's", () => {
    expect(opencodePathPatterns("**/.env*")).toEqual([".env*", "*/.env*"]);
    expect(opencodePathPatterns("**/*.pem")).toEqual(["*.pem"]);
    expect(opencodePathPatterns("//etc/claude-code/**")).toEqual(["/etc/claude-code/*"]);
    expect(opencodePathPatterns("~/.ssh/**")).toEqual([".ssh/*", "*/.ssh/*"]);
    expect(opencodePathPatterns("./config/prod.yaml")).toEqual([
      "config/prod.yaml",
      "*/config/prod.yaml",
    ]);
  });

  it("maps Read, Edit/Write and Bash, and leaves Claude Code-only tools out", () => {
    expect(
      opencodeDenyPermission([
        "Read(**/*.pem)",
        "Write(**/.github/**)",
        "Bash(git push --force*)",
        "Bash(npm publish:*)",
        "WebFetch(domain:example.com)",
      ]),
    ).toEqual({
      read: { "*.pem": "deny" },
      edit: { ".github/*": "deny", "*/.github/*": "deny" },
      bash: { "git push --force*": "deny", "npm publish*": "deny" },
    });
    expect(opencodeDenyPermission(["Bash"])).toEqual({ bash: { "*": "deny" } });
    expect(opencodeSupportsRule("Read(x)")).toBe(true);
    expect(opencodeSupportsRule("WebFetch(domain:x)")).toBe(false);
  });
});

describe("the built-in force-push rules", () => {
  // Claude Code's Bash(...) rules are globs: `*` matches any run of characters.
  const matches = (rule: string, command: string) => {
    const m = /^Bash\((.*)\)$/.exec(rule);
    if (!m) return false;
    const re = m[1]!.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${re.join(".*")}$`).test(command);
  };
  const denied = (command: string) => STANDARD_DENY_RULES.some((rule) => matches(rule, command));

  it("let Optio's own conflict push through (--force-with-lease)", () => {
    expect(denied("git push --force-with-lease")).toBe(false);
    expect(denied("git push --force-with-lease origin HEAD")).toBe(false);
    expect(denied("git push origin HEAD --force-with-lease")).toBe(false);
    expect(denied("git push origin optio/task-1")).toBe(false);
  });

  it("stop a plain force push, before or after the remote", () => {
    expect(denied("git push --force")).toBe(true);
    expect(denied("git push --force origin main")).toBe(true);
    expect(denied("git push -f origin main")).toBe(true);
    expect(denied("git push origin main --force")).toBe(true);
    expect(denied("git push origin main -f")).toBe(true);
  });
});

describe("a run on an agent image without /etc/claude-code", () => {
  it("names the image, not a generic failure", () => {
    for (const log of [
      "PermissionError: [Errno 13] Permission denied: '/etc/claude-code'",
      "PermissionError: [Errno 13] Permission denied: '/etc/claude-code/managed-settings.json'",
    ]) {
      const result = classifyError(`[optio] Writing setup files...\n${log}`);
      expect(result.category).toBe("image");
      expect(result.title).toBe("Agent image can't take the agent policy");
      expect(result.retryable).toBe(false);
    }
  });
});
