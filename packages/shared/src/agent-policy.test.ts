import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "./error-classifier.js";
import {
  AgentPolicyError,
  STANDARD_DENY_RULES,
  claudeManagedSettings,
  cleanAgentPolicy,
  denyRuleError,
  mergeOpencodePermission,
  opencodeDenyPermission,
  opencodePathPatterns,
  opencodeSupportsRule,
  agentPolicyDefaultsOn,
  resolveAgentPolicy,
  runtimeClassNameError,
} from "./agent-policy.js";

describe("the deployment's default for the built-in rules", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off with nothing set, as upstream: no rules", () => {
    vi.stubEnv("OPTIO_AGENT_POLICY_DEFAULTS", "");
    expect(agentPolicyDefaultsOn()).toBe(false);
    expect(resolveAgentPolicy({}).rules).toEqual([]);
    expect(claudeManagedSettings(resolveAgentPolicy({}))).toBeNull();
  });

  it("is on with OPTIO_AGENT_POLICY_DEFAULTS=true", () => {
    vi.stubEnv("OPTIO_AGENT_POLICY_DEFAULTS", "true");
    expect(agentPolicyDefaultsOn()).toBe(true);
    const p = resolveAgentPolicy({});
    expect(p.defaults).toBe(true);
    expect(p.rules.map((r) => r.rule)).toEqual([...STANDARD_DENY_RULES]);
  });
});

describe("resolveAgentPolicy", () => {
  it("follows the deployment's default for the built-in rules when the workspace hasn't said", () => {
    const std = resolveAgentPolicy({ builtInDefaults: true });
    expect(std.defaults).toBe(true);
    expect(std.defaultsFrom).toBe("profile");
    expect(std.rules.map((r) => r.rule)).toEqual([...STANDARD_DENY_RULES]);
    expect(std.rules.every((r) => r.from === "default")).toBe(true);

    const full = resolveAgentPolicy({ builtInDefaults: false });
    expect(full.defaults).toBe(false);
    expect(full.rules).toEqual([]);
  });

  it("follows the workspace's choice over the deployment's", () => {
    expect(
      resolveAgentPolicy({ builtInDefaults: false, workspace: { defaults: true } }).rules,
    ).toHaveLength(STANDARD_DENY_RULES.length);
    const off = resolveAgentPolicy({ builtInDefaults: true, workspace: { defaults: false } });
    expect(off.defaults).toBe(false);
    expect(off.defaultsFrom).toBe("workspace");
    expect(off.rules).toEqual([]);
  });

  it("adds the workspace's, the team's and the repo's rules in that order, each once", () => {
    const p = resolveAgentPolicy({
      builtInDefaults: false,
      workspace: { denyRules: ["Read(**/secrets/**)", "Bash(terraform apply*)"] },
      team: { denyRules: ["Bash(terraform apply*)", "Bash(kubectl delete*)"] },
      repo: { denyRules: ["Read(**/fixtures/prod.json)"] },
    });
    expect(p.rules).toEqual([
      { rule: "Read(**/secrets/**)", from: "workspace" },
      { rule: "Bash(terraform apply*)", from: "workspace" },
      { rule: "Bash(kubectl delete*)", from: "team" },
      { rule: "Read(**/fixtures/prod.json)", from: "repo" },
    ]);
  });

  it("keeps a built-in rule a lower level repeats as the built-in one", () => {
    const p = resolveAgentPolicy({
      builtInDefaults: true,
      repo: { denyRules: ["Read(**/*.pem)"] },
    });
    expect(p.rules.filter((r) => r.rule === "Read(**/*.pem)")).toEqual([
      { rule: "Read(**/*.pem)", from: "default" },
    ]);
  });

  it("ignores what a stored level holds that isn't a rule", () => {
    const p = resolveAgentPolicy({
      builtInDefaults: false,
      team: { denyRules: [42 as unknown as string, " ", "Bash(x)"] },
      repo: { denyRules: "Read(x)" as unknown as string[] },
    });
    expect(p.rules).toEqual([{ rule: "Bash(x)", from: "team" }]);
  });

  it("takes the repo's RuntimeClass over the deployment's", () => {
    expect(resolveAgentPolicy({ deploymentRuntimeClass: "gvisor" })).toMatchObject({
      runtimeClassName: "gvisor",
      runtimeClassFrom: "deployment",
    });
    expect(
      resolveAgentPolicy({ deploymentRuntimeClass: "gvisor", repo: { runtimeClassName: "kata" } }),
    ).toMatchObject({ runtimeClassName: "kata", runtimeClassFrom: "repo" });
    expect(resolveAgentPolicy({ deploymentRuntimeClass: " " })).toMatchObject({
      runtimeClassName: null,
      runtimeClassFrom: null,
    });
  });
});

describe("claudeManagedSettings", () => {
  it("writes the rules as permissions.deny and nothing else", () => {
    const settings = claudeManagedSettings(resolveAgentPolicy({ builtInDefaults: true }));
    expect(Object.keys(settings!)).toEqual(["permissions"]);
    expect(Object.keys(settings!.permissions)).toEqual(["deny"]);
    expect(settings!.permissions.deny).toContain("Read(**/.env*)");
    expect(settings!.permissions.deny).toContain("Read(**/*.pem)");
    expect(settings!.permissions.deny).toContain("Read(**/*.key)");
    expect(settings!.permissions.deny).toContain("Bash(git push --force *)");
    expect(settings!.permissions.deny).toContain("Bash(curl * | sh*)");
  });

  it("is null for a policy with no rules, so nothing is written", () => {
    expect(claudeManagedSettings(resolveAgentPolicy({ builtInDefaults: false }))).toBeNull();
  });
});

describe("cleanAgentPolicy", () => {
  it("trims, drops blanks and repeats, and keeps only the level's fields", () => {
    expect(
      cleanAgentPolicy(
        {
          defaults: false,
          denyRules: [" Bash(x) ", "", "Bash(x)", "Read(y)"],
          runtimeClassName: "gvisor",
        },
        "workspace",
      ),
    ).toEqual({ defaults: false, denyRules: ["Bash(x)", "Read(y)"] });
    expect(cleanAgentPolicy({ defaults: true, runtimeClassName: "kata" }, "team")).toBeNull();
    expect(cleanAgentPolicy({ runtimeClassName: " kata " }, "repo")).toEqual({
      runtimeClassName: "kata",
    });
  });

  it("is null when nothing is left", () => {
    expect(cleanAgentPolicy({ denyRules: [" "] }, "repo")).toBeNull();
  });

  it("refuses a malformed rule or RuntimeClass, naming each", () => {
    expect(() =>
      cleanAgentPolicy({ denyRules: ["Read(", "Bash()", "read secrets please"] }, "team"),
    ).toThrow(AgentPolicyError);
    try {
      cleanAgentPolicy({ denyRules: ["Read(", "Bash()"] }, "team");
    } catch (err) {
      expect((err as Error).message).toContain('"Read("');
      expect((err as Error).message).toContain('"Bash()" has nothing between the brackets');
    }
    expect(() => cleanAgentPolicy({ runtimeClassName: "Not_A_Class" }, "repo")).toThrow(
      "isn't a RuntimeClass name",
    );
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
    expect(denyRuleError("x".repeat(301))).toContain("longer than");
  });

  it("checks RuntimeClass names as DNS subdomains", () => {
    expect(runtimeClassNameError("gvisor")).toBeNull();
    expect(runtimeClassNameError("kata-qemu.v2")).toBeNull();
    expect(runtimeClassNameError("-x")).not.toBeNull();
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

  it("adds the denials after the headless block's own entries, which stay", () => {
    const base = {
      "*": "allow",
      question: "deny",
      bash: { "sudo *": "deny" },
      edit: "allow",
    };
    const merged = mergeOpencodePermission(base, {
      bash: { "git push --force*": "deny" },
      edit: { "*.pem": "deny" },
      read: { "*.env*": "deny" },
    });
    expect(merged["*"]).toBe("allow");
    expect(merged.question).toBe("deny");
    expect(merged.bash).toEqual({ "sudo *": "deny", "git push --force*": "deny" });
    expect(Object.keys(merged.edit as object)).toEqual(["*", "*.pem"]);
    expect(merged.read).toEqual({ "*.env*": "deny" });
    // The base block is not changed in place.
    expect(base.bash).toEqual({ "sudo *": "deny" });
  });
});

describe("a run on an agent image too old for the policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names the image, not a generic failure", () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    const result = classifyError(
      "[optio] Writing setup files...\nPermissionError: [Errno 13] Permission denied: '/etc/claude-code'",
    );
    expect(result.category).toBe("image");
    expect(result.title).toBe("Agent image too old for the agent policy");
    expect(result.remedy).toContain("Build the agent images from this Optio release");
  });
});

describe("the built-in force-push rules", () => {
  // Claude Code's Bash(...) rules are globs: `*` matches any run of characters.
  const matches = (rule: string, command: string) => {
    const m = /^Bash\((.*)\)$/.exec(rule);
    if (!m) return false;
    const re = m[1].split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${re.join(".*")}$`).test(command);
  };
  const denied = (command: string) => STANDARD_DENY_RULES.some((rule) => matches(rule, command));

  it("let the conflict prompts' push through (--force-with-lease on the run's branch)", () => {
    expect(denied("git push --force-with-lease")).toBe(false);
    expect(denied("git push --force-with-lease origin HEAD")).toBe(false);
    expect(denied("git push origin HEAD --force-with-lease")).toBe(false);
    expect(denied("git push origin optio/task-1")).toBe(false);
  });

  it("deny a plain force push, wherever the flag is", () => {
    expect(denied("git push --force")).toBe(true);
    expect(denied("git push --force origin main")).toBe(true);
    expect(denied("git push origin main --force")).toBe(true);
    expect(denied("git push origin --force main")).toBe(true);
    expect(denied("git push -f")).toBe(true);
    expect(denied("git push -f origin main")).toBe(true);
    expect(denied("git push origin main -f")).toBe(true);
  });
});
