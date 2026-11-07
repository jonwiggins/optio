import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentEgress,
  agentEgressAllowlistOn,
  cidrError,
  deploymentBuiltInRules,
  deploymentRuntimeClass,
  egressEntryError,
} from "./agent-policy-env.js";
import { restrictedAgentNetworkPolicy } from "./agent-network-policy.js";
import { agentNodePlacement } from "../services/agent-node-placement.js";

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

afterEach(() => vi.unstubAllEnvs());

describe("the deployment's built-in rules switch", () => {
  it("is off unless the operator says true", () => {
    expect(deploymentBuiltInRules(env({}))).toBe(false);
    expect(deploymentBuiltInRules(env({ OPTIO_AGENT_POLICY_DEFAULTS: "false" }))).toBe(false);
    expect(deploymentBuiltInRules(env({ OPTIO_AGENT_POLICY_DEFAULTS: " TRUE " }))).toBe(true);
  });
});

describe("the agent RuntimeClass", () => {
  it("is none by default and the operator's name otherwise", () => {
    expect(deploymentRuntimeClass(env({}))).toBeNull();
    expect(deploymentRuntimeClass(env({ OPTIO_AGENT_RUNTIME_CLASS: " gvisor " }))).toBe("gvisor");
  });

  it("throws on a name that isn't one, so no pod starts without the sandbox", () => {
    expect(() => deploymentRuntimeClass(env({ OPTIO_AGENT_RUNTIME_CLASS: "Not_A_Class" }))).toThrow(
      "isn't a RuntimeClass name",
    );
  });

  it("goes on every agent pod's placement, and nothing changes without it", () => {
    vi.stubEnv("OPTIO_AGENT_RUNTIME_CLASS", "");
    vi.stubEnv("OPTIO_AGENT_NODE_SELECTOR", "");
    vi.stubEnv("OPTIO_AGENT_TOLERATIONS", "");
    expect(agentNodePlacement()).toEqual({});
    vi.stubEnv("OPTIO_AGENT_RUNTIME_CLASS", "kata");
    expect(agentNodePlacement()).toEqual({ runtimeClassName: "kata" });
    vi.stubEnv("OPTIO_AGENT_RUNTIME_CLASS", "bad name");
    expect(() => agentNodePlacement()).toThrow();
  });
});

describe("the egress allowlist", () => {
  it("checks CIDRs and never accepts the whole internet", () => {
    expect(cidrError("10.20.0.15/32")).toBeNull();
    expect(cidrError("fd00::/64")).toBeNull();
    for (const bad of ["10.0.0.300/32", "10.0.0.0", "10.0.0.0/33", "0.0.0.0/0", "::/0", "x/8", 7]) {
      expect(cidrError(bad), String(bad)).not.toBeNull();
    }
  });

  it("refuses entries with no destination, a host name, or bad ports", () => {
    expect(egressEntryError({ cidr: "10.0.0.1/32", ports: [443, 22] }, 0)).toBeNull();
    expect(egressEntryError({ namespace: "ingress-nginx", podLabels: { app: "x" } }, 0)).toBeNull();
    expect(egressEntryError({ name: "x" }, 0)).toContain("needs cidr, cidrs or namespace");
    expect(egressEntryError({ host: "gitlab.example.com" }, 0)).toContain("not host names");
    expect(egressEntryError({ cidr: "10.0.0.1/32", ports: [0] }, 0)).toContain("ports");
    expect(egressEntryError({ cidr: "10.0.0.1/32", ports: [1.5] }, 0)).toContain("ports");
    expect(egressEntryError({ namespace: "Bad_NS" }, 0)).toContain("namespace");
    expect(egressEntryError({ namespace: "a", except: ["10.0.0.0/8"] }, 0)).toContain("except");
  });

  it("shows the chart's list", () => {
    expect(agentEgress(env({}))).toEqual({ mode: "not-set", entries: [] });
    expect(agentEgress(env({ OPTIO_AGENT_EGRESS: "[]" }))).toEqual({
      mode: "default",
      entries: [],
    });
    expect(
      agentEgress(
        env({
          OPTIO_AGENT_EGRESS: JSON.stringify([
            { name: "GitLab", cidr: "10.20.0.15/32", ports: [443, 22] },
            { namespace: "ingress-nginx", podLabels: { app: "nginx" } },
          ]),
        }),
      ),
    ).toEqual({
      mode: "allowlist",
      entries: [
        { name: "GitLab", to: ["10.20.0.15/32"], ports: [443, 22] },
        { name: "Entry 2", to: ["namespace ingress-nginx, pods app=nginx"], ports: [443] },
      ],
    });
  });

  it("counts a setting it can't read as on, so a restricted repo never widens it", () => {
    for (const raw of ["{not json", '{"a":1}', JSON.stringify([{ cidr: "0.0.0.0/0" }])]) {
      const e = env({ OPTIO_AGENT_EGRESS: raw });
      expect(agentEgress(e).mode).toBe("invalid");
      expect(agentEgressAllowlistOn(e)).toBe(true);
    }
    expect(agentEgressAllowlistOn(env({}))).toBe(false);
  });

  it("drops a restricted repo's public HTTPS rule while the allowlist is on", () => {
    const ports = (publicHttps?: boolean) =>
      restrictedAgentNetworkPolicy("repo-0", "optio", 4000, [], { publicHttps }).spec.egress.map(
        (r) => r.ports.map((p) => p.port),
      );
    expect(ports(undefined)).toEqual([[53, 53], [443], [4000]]);
    expect(ports(false)).toEqual([[53, 53], [4000]]);
  });
});
