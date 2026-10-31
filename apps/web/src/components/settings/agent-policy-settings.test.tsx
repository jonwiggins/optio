import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getAgentPolicy: vi.fn(),
  setAgentPolicy: vi.fn(),
  getRepoAgentPolicy: vi.fn(),
  setRepoAgentPolicy: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AgentPolicySettings } from "./agent-policy-settings";
import { RepoAgentPolicy } from "../repos/repo-agent-policy";

const view = (over: Record<string, unknown> = {}) => ({
  policy: null,
  effective: { builtInRules: false, builtInFrom: null, rules: [] },
  builtIn: ["Read(**/.env*)"],
  deployment: {
    builtInRules: false,
    runtimeClassName: null,
    egress: { mode: "not-set", entries: [] },
  },
  canEdit: true,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentPolicySettings", () => {
  it("lets a workspace admin save rules and turn the built-in rules on", async () => {
    api.getAgentPolicy.mockResolvedValue(view());
    api.setAgentPolicy.mockResolvedValue(view({ policy: { denyRules: ["Bash(x)"] } }));
    render(<AgentPolicySettings />);
    const area = await screen.findByTestId("workspace-deny-rules");
    fireEvent.change(area, { target: { value: " Bash(x) \n\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.setAgentPolicy).toHaveBeenCalledWith({ denyRules: ["Bash(x)"] }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Built-in rules for this workspace" }));
    await waitFor(() => expect(api.setAgentPolicy).toHaveBeenCalledWith({ builtInRules: true }));
  });

  it("shows a member the rules without anything to change", async () => {
    api.getAgentPolicy.mockResolvedValue(
      view({ canEdit: false, policy: { denyRules: ["Bash(x)"] } }),
    );
    render(<AgentPolicySettings />);
    expect((await screen.findByTestId("workspace-deny-rules")).tagName).toBe("UL");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("has no switch to turn off what the deployment turned on", async () => {
    api.getAgentPolicy.mockResolvedValue(
      view({
        deployment: { ...view().deployment, builtInRules: true },
        effective: {
          builtInRules: true,
          builtInFrom: "deployment",
          rules: [{ rule: "Read(**/.env*)", from: "built-in", opencode: true }],
        },
      }),
    );
    render(<AgentPolicySettings />);
    expect(await screen.findByText("On for every workspace in this deployment.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows the operator's allowlist and RuntimeClass", async () => {
    api.getAgentPolicy.mockResolvedValue(
      view({
        deployment: {
          builtInRules: false,
          runtimeClassName: "gvisor",
          egress: {
            mode: "allowlist",
            entries: [{ name: "GitLab", to: ["10.20.0.15/32"], ports: [443, 22] }],
          },
        },
      }),
    );
    render(<AgentPolicySettings />);
    expect((await screen.findByTestId("agent-egress")).textContent).toContain(
      "GitLab10.20.0.15/32 · ports 443, 22",
    );
    expect(screen.getByTestId("agent-runtime-class").textContent).toContain("gvisor");
  });
});

describe("RepoAgentPolicy", () => {
  it("saves the repo's rules", async () => {
    api.getRepoAgentPolicy.mockResolvedValue({ policy: null, canEdit: true });
    api.setRepoAgentPolicy.mockResolvedValue({ policy: { denyRules: ["Read(x)"] }, canEdit: true });
    render(<RepoAgentPolicy repoId="r1" />);
    fireEvent.change(await screen.findByTestId("repo-deny-rules"), {
      target: { value: "Read(x)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.setRepoAgentPolicy).toHaveBeenCalledWith("r1", { denyRules: ["Read(x)"] }),
    );
  });
});
