import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkspaceDeploymentAdmins } from "./workspace-deployment-admins";

afterEach(() => cleanup());

const row = (over: Record<string, unknown>) => ({
  userId: "u1",
  email: "ops@acme.io",
  displayName: "Ops Lead",
  avatarUrl: null,
  membershipRole: null,
  ...over,
});

describe("WorkspaceDeploymentAdmins", () => {
  it("renders nothing while the grant is off (no admins sent)", () => {
    const { container } = render(<WorkspaceDeploymentAdmins admins={[]} />);
    expect(container.textContent).toBe("");
  });

  it("lists each deployment admin and how they relate to the workspace", () => {
    render(
      <WorkspaceDeploymentAdmins
        admins={[
          row({}),
          row({ userId: "u2", displayName: "Viewer Too", membershipRole: "viewer" }),
          row({ userId: "u3", displayName: "Admin Member", membershipRole: "admin" }),
        ]}
      />,
    );
    const items = screen
      .getByRole("list", { name: "Deployment admins in this workspace" })
      .querySelectorAll("li");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("not a member");
    expect(items[1].textContent).toContain("also a viewer");
    expect(items[2].textContent).not.toMatch(/not a member|also a/);
    for (const li of items) expect(li.textContent).toContain("Deployment admin");
  });
});
