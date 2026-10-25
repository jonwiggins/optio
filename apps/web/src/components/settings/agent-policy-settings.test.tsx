import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RunPolicy, WorkspacePolicyView } from "@/lib/agent-policy-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const api = vi.hoisted(() => ({
  workspace: vi.fn(),
  setWorkspace: vi.fn(),
  team: vi.fn(),
  setTeam: vi.fn(),
  repo: vi.fn(),
  setRepo: vi.fn(),
  run: vi.fn(),
}));
vi.mock("@/lib/agent-policy-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-policy-api")>()),
  agentPolicyApi: api,
}));

import { AgentPolicySettings } from "./agent-policy-settings";
import { TeamAgentPolicy } from "@/components/teams/team-agent-policy";
import { RepoAgentPolicy } from "@/components/repos/repo-agent-policy";
import { RunAgentPolicy } from "@/components/tasks/run-agent-policy";

function viewOf(over: Partial<WorkspacePolicyView> = {}): WorkspacePolicyView {
  return {
    policy: { denyRules: ["Bash(terraform apply*)"] },
    effective: {
      defaults: true,
      defaultsFrom: "profile",
      rules: [
        { rule: "Read(**/.env*)", from: "default", opencode: true },
        { rule: "Bash(terraform apply*)", from: "workspace", opencode: true },
      ],
      runtimeClassName: null,
      runtimeClassFrom: null,
    },
    builtIn: ["Read(**/.env*)", "Read(**/*.pem)", "Bash(git push --force*)"],
    profileDefaults: true,
    egress: {
      mode: "allowlist",
      always: ["DNS (port 53)", "The Optio API"],
      entries: [{ name: "GitLab", to: ["10.0.0.5/32"], ports: [443, 22] }],
    },
    runtime: { deployment: "gvisor", available: ["gvisor", "kata"] },
    canEdit: true,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("Workspace settings → Agent policy", () => {
  it("shows the built-in rules, the egress allowlist and the RuntimeClasses", async () => {
    api.workspace.mockResolvedValue(viewOf());
    render(<AgentPolicySettings />);
    await screen.findByTestId("agent-policy-settings");
    expect(screen.getByText("Read(**/*.pem)")).toBeTruthy();
    expect(screen.getByText("Bash(git push --force*)")).toBeTruthy();
    expect(screen.getByText("GitLab")).toBeTruthy();
    expect(screen.getByText(/10\.0\.0\.5\/32 · ports 443, 22/)).toBeTruthy();
    expect(screen.getByText("DNS (port 53)")).toBeTruthy();
    expect(screen.getByText("gvisor, kata")).toBeTruthy();
  });

  it("an admin saves the workspace's rules, one per line", async () => {
    api.workspace.mockResolvedValue(viewOf());
    api.setWorkspace.mockResolvedValue({ policy: null, canEdit: true });
    render(<AgentPolicySettings />);
    const area = (await screen.findByTestId("workspace-deny-rules")) as HTMLTextAreaElement;
    expect(area.value).toBe("Bash(terraform apply*)");
    // As below: type until the editor's own effect has run and Save is enabled.
    await waitFor(() => {
      fireEvent.change(area, {
        target: { value: "Bash(terraform apply*)\n\n  Read(**/prod.tfvars) " },
      });
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.setWorkspace).toHaveBeenCalledWith({
        defaults: null,
        denyRules: ["Bash(terraform apply*)", "Read(**/prod.tfvars)"],
      }),
    );
  });

  it("an admin turns the built-in rules off", async () => {
    api.workspace.mockResolvedValue(viewOf());
    api.setWorkspace.mockResolvedValue({ policy: null, canEdit: true });
    render(<AgentPolicySettings />);
    await screen.findByTestId("agent-policy-settings");
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    await waitFor(() =>
      expect(api.setWorkspace).toHaveBeenCalledWith({
        defaults: false,
        denyRules: ["Bash(terraform apply*)"],
      }),
    );
  });

  it("a member reads the rules and can't change them", async () => {
    api.workspace.mockResolvedValue(viewOf({ canEdit: false }));
    render(<AgentPolicySettings />);
    await screen.findByTestId("agent-policy-settings");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Off" })).toBeNull();
    expect(screen.getByTestId("workspace-deny-rules").textContent).toContain(
      "Bash(terraform apply*)",
    );
  });

  it("says when nothing enforces egress", async () => {
    api.workspace.mockResolvedValue(
      viewOf({ egress: { mode: "unenforced", always: [], entries: [] } }),
    );
    render(<AgentPolicySettings />);
    expect(await screen.findByText(/No NetworkPolicy/)).toBeTruthy();
  });
});

describe("a team's and a repo's rules", () => {
  it("a team admin saves the team's rules", async () => {
    api.team.mockResolvedValue({ policy: null, canEdit: true });
    api.setTeam.mockResolvedValue({
      policy: { denyRules: ["Bash(kubectl delete*)"] },
      canEdit: true,
    });
    render(<TeamAgentPolicy teamId="t-1" />);
    const area = await screen.findByTestId("team-deny-rules");
    // The editor takes the loaded rules in an effect; on a slow runner that can
    // land after a first change. Type until Save is enabled, then save.
    await waitFor(() => {
      fireEvent.change(area, { target: { value: "Bash(kubectl delete*)" } });
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.setTeam).toHaveBeenCalledWith("t-1", { denyRules: ["Bash(kubectl delete*)"] }),
    );
  });

  it("a member of a team with no rules sees nothing", async () => {
    api.team.mockResolvedValue({ policy: null, canEdit: false });
    const { container } = render(<TeamAgentPolicy teamId="t-1" />);
    await waitFor(() => expect(api.team).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("an admin picks a repo's RuntimeClass from the deployment's list", async () => {
    api.repo.mockResolvedValue({
      policy: { denyRules: ["Read(x)"] },
      canEdit: true,
      runtime: { deployment: null, available: ["gvisor", "kata"] },
    });
    api.setRepo.mockResolvedValue({
      policy: { denyRules: ["Read(x)"], runtimeClassName: "kata" },
      canEdit: true,
      runtime: { deployment: null, available: ["gvisor", "kata"] },
    });
    render(<RepoAgentPolicy repoId="r-1" />);
    const select = await screen.findByRole("combobox", { name: "RuntimeClass" });
    fireEvent.change(select, { target: { value: "kata" } });
    await waitFor(() =>
      expect(api.setRepo).toHaveBeenCalledWith("r-1", {
        denyRules: ["Read(x)"],
        runtimeClassName: "kata",
      }),
    );
  });
});

describe("the run page", () => {
  const run: RunPolicy = {
    defaults: true,
    defaultsFrom: "profile",
    rules: [
      { rule: "Read(**/.env*)", from: "default", opencode: true },
      { rule: "WebFetch(domain:x.test)", from: "repo", opencode: false },
    ],
    runtimeClassName: "gvisor",
    runtimeClassFrom: "deployment",
    agentType: "claude-code",
    enforcedBy: "claude-managed-settings",
    notEnforced: [],
    appliedAt: new Date().toISOString(),
  };

  it("shows the rules the run started with and how they reached the agent", async () => {
    api.run.mockResolvedValue({ policy: run });
    render(<RunAgentPolicy runId="run-1" />);
    await screen.findByTestId("run-agent-policy");
    expect(screen.getByText("Claude Code's managed settings")).toBeTruthy();
    expect(
      screen.getByText(/2 deny rules \(built-in ones on\) · RuntimeClass gvisor/),
    ).toBeTruthy();
    expect(screen.getByText("Claude Code only")).toBeTruthy();
    expect(screen.getByText("Built-in")).toBeTruthy();
  });

  it("shows nothing for a run from before agent policy", async () => {
    api.run.mockResolvedValue({ policy: null });
    const { container } = render(<RunAgentPolicy runId="run-0" />);
    await waitFor(() => expect(api.run).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
