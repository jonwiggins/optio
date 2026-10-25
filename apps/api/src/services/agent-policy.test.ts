import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));

import { resolveAgentPolicy, type AgentContainerConfig } from "@optio/shared";
import {
  RuntimeClassUnavailableError,
  agentEgress,
  agentEgressAllowlistOn,
  assertRuntimeClassAvailable,
  availableRuntimeClasses,
  deploymentRuntimeClass,
  policyChange,
  policyForRuntime,
  teamOfOwner,
} from "./agent-policy.js";
import { agentNodePlacement } from "./agent-node-placement.js";

type SetupFile = NonNullable<AgentContainerConfig["setupFiles"]>[number];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the RuntimeClass", () => {
  it("is the chart's agent.runtimeClassName, on every agent pod", () => {
    expect(deploymentRuntimeClass({})).toBeNull();
    expect(deploymentRuntimeClass({ OPTIO_AGENT_RUNTIME_CLASS: " gvisor " })).toBe("gvisor");
    vi.stubEnv("OPTIO_AGENT_RUNTIME_CLASS", "gvisor");
    expect(agentNodePlacement()).toEqual({ runtimeClassName: "gvisor" });
    vi.stubEnv("OPTIO_AGENT_RUNTIME_CLASS", "");
    expect(agentNodePlacement()).toEqual({});
  });

  it("a repo may pick one the chart lists, or the deployment's own", () => {
    const env = {
      OPTIO_AGENT_RUNTIME_CLASS: "gvisor",
      OPTIO_AGENT_RUNTIME_CLASSES: "kata, gvisor",
    };
    expect(availableRuntimeClasses(env)).toEqual(["gvisor", "kata"]);
    expect(() => assertRuntimeClassAvailable("kata", env)).not.toThrow();
    expect(() => assertRuntimeClassAvailable("runsc", env)).toThrow(RuntimeClassUnavailableError);
    expect(() => assertRuntimeClassAvailable("runsc", env)).toThrow(
      'RuntimeClass "runsc" is not available in this deployment (available: gvisor, kata)',
    );
    expect(() => assertRuntimeClassAvailable("kata", {})).toThrow(
      "it lists none (the chart's agent.runtimeClasses)",
    );
  });
});

describe("the egress allowlist, as Settings shows it", () => {
  it("is upstream's rule when the list is empty, unenforced without a NetworkPolicy", () => {
    expect(agentEgress({}).mode).toBe("unenforced");
    expect(agentEgress({ OPTIO_AGENT_EGRESS: "not json" }).mode).toBe("unenforced");
    expect(agentEgress({ OPTIO_AGENT_EGRESS: '{"enforced":true,"allow":[]}' })).toEqual({
      mode: "any-https",
      always: ["DNS (port 53)", "The Optio API"],
      entries: [],
    });
    expect(
      agentEgress({
        OPTIO_AGENT_EGRESS: JSON.stringify({ enforced: false, allow: [{ cidr: "10.0.0.0/8" }] }),
      }).mode,
    ).toBe("unenforced");
  });

  it("names each entry's addresses, namespaces and ports (443 by default)", () => {
    const view = agentEgress({
      OPTIO_AGENT_EGRESS: JSON.stringify({
        enforced: true,
        allow: [
          { name: "GitLab", cidr: "10.1.2.3/32", ports: [443, 22] },
          {
            name: "Site ingress",
            namespace: "ingress-nginx",
            podLabels: { "app.kubernetes.io/name": "ingress-nginx" },
          },
          { cidrs: ["10.9.0.0/16", "10.8.0.0/16"] },
        ],
      }),
    });
    expect(view.mode).toBe("allowlist");
    expect(view.entries).toEqual([
      { name: "GitLab", to: ["10.1.2.3/32"], ports: [443, 22] },
      {
        name: "Site ingress",
        to: ["namespace ingress-nginx, pods app.kubernetes.io/name=ingress-nginx"],
        ports: [443],
      },
      { name: "Entry 3", to: ["10.9.0.0/16", "10.8.0.0/16"], ports: [443] },
    ]);
    vi.stubEnv("OPTIO_AGENT_EGRESS", JSON.stringify({ enforced: true, allow: [{ cidr: "x" }] }));
    expect(agentEgressAllowlistOn()).toBe(true);
  });
});

describe("what one runtime gets", () => {
  it("Claude Code: /etc/claude-code/managed-settings.json with permissions.deny", () => {
    const files: SetupFile[] = [];
    const env: Record<string, string> = {};
    const run = policyForRuntime(
      resolveAgentPolicy({
        builtInDefaults: true,
        repo: { denyRules: ["WebFetch(domain:x.test)"] },
      }),
      "claude-code",
      files,
      env,
    );
    // Optio's marker, then the settings (last: what Claude Code reads).
    expect(files.map((f) => f.path)).toEqual([
      "/etc/claude-code/managed-settings.json.optio",
      "/etc/claude-code/managed-settings.json",
    ]);
    expect(files[1].sensitive).toBeUndefined();
    const settings = JSON.parse(files[1].content);
    expect(settings.permissions.deny).toContain("Read(**/.env*)");
    expect(settings.permissions.deny).toContain("Read(**/*.pem)");
    expect(settings.permissions.deny).toContain("Bash(git push --force *)");
    expect(settings.permissions.deny.at(-1)).toBe("WebFetch(domain:x.test)");
    // Blank, so a pod secret of that name can't remove the file just written.
    expect(env).toEqual({ OPTIO_CLAUDE_POLICY_CLEAR: "" });
    expect(run.enforcedBy).toBe("claude-managed-settings");
    expect(run.notEnforced).toEqual([]);
  });

  it("Claude Code with no rules: no file, and the pod removes an earlier run's", () => {
    const files: SetupFile[] = [];
    const env: Record<string, string> = { OPTIO_CLAUDE_POLICY_CLEAR: "" };
    const run = policyForRuntime(
      resolveAgentPolicy({ builtInDefaults: false }),
      "claude-code",
      files,
      env,
    );
    expect(files).toEqual([]);
    expect(env).toEqual({ OPTIO_CLAUDE_POLICY_CLEAR: "1" });
    expect(run.enforcedBy).toBeNull();
  });

  it("OpenCode: notes the rules it has no equivalent for", () => {
    const env: Record<string, string> = {};
    const run = policyForRuntime(
      resolveAgentPolicy({
        builtInDefaults: false,
        workspace: { denyRules: ["WebFetch(domain:x)", "Read(a)"] },
      }),
      "opencode",
      [],
      env,
    );
    expect(run.enforcedBy).toBe("opencode-config");
    expect(run.notEnforced).toEqual(["WebFetch(domain:x)"]);
    // The work's own OPENCODE_CONFIG_CONTENT (a pod secret) is the pod's to
    // merge into (utils/agent-policy-pod.ts), never replaced here.
    expect(env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
    const sent = JSON.parse(env.OPTIO_OPENCODE_POLICY);
    expect(sent.deny.read).toEqual({ a: "deny", "*/a": "deny" });
    expect(sent.base).toMatchObject({ "*": "allow", question: "deny" });
  });

  it("OpenCode with no rule it can take: nothing to merge", () => {
    const env: Record<string, string> = { OPENCODE_CONFIG_CONTENT: '{"model":"local/x"}' };
    const run = policyForRuntime(
      resolveAgentPolicy({
        builtInDefaults: false,
        workspace: { denyRules: ["WebFetch(domain:x)"] },
      }),
      "opencode",
      [],
      env,
    );
    expect(env).toEqual({
      OPENCODE_CONFIG_CONTENT: '{"model":"local/x"}',
      OPTIO_OPENCODE_POLICY: "",
    });
    expect(run.enforcedBy).toBeNull();
    expect(run.notEnforced).toEqual(["WebFetch(domain:x)"]);
  });

  it("another runtime gets nothing, and says so", () => {
    const files: SetupFile[] = [];
    const run = policyForRuntime(resolveAgentPolicy({ builtInDefaults: true }), "codex", files, {});
    expect(files).toEqual([]);
    expect(run.enforcedBy).toBeNull();
    expect(run.notEnforced.length).toBeGreaterThan(0);
  });
});

describe("small helpers", () => {
  it("reads the team out of a work spec's owner", () => {
    expect(teamOfOwner("team:abc")).toBe("abc");
    expect(teamOfOwner("me")).toBeNull();
    expect(teamOfOwner(null)).toBeNull();
    expect(teamOfOwner("team:")).toBeNull();
  });

  it("describes a change for the audit trail", () => {
    expect(
      policyChange(
        { denyRules: ["a", "b"], defaults: true },
        { denyRules: ["b", "c"], runtimeClassName: "kata" },
      ),
    ).toEqual({ added: ["c"], removed: ["a"], defaults: null, runtimeClassName: "kata" });
    expect(policyChange(null, null)).toEqual({ added: [], removed: [] });
  });
});
