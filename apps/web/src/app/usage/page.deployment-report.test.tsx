import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/lib/api-client", () => ({
  api: {
    listRepos: () => new Promise(() => {}),
    getUsageAnalytics: () => new Promise(() => {}),
  },
}));
vi.mock("@/components/usage/deployment-report", () => ({
  DeploymentUsageReportPanel: () => <div>deployment report</div>,
}));
const view = { isAdmin: true, isDeploymentAdmin: false };
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => view }));

import UsagePage from "./page";

describe("Usage page: deployment report", () => {
  afterEach(() => cleanup());

  it.each([
    [{ isAdmin: true, isDeploymentAdmin: true }, true],
    [{ isAdmin: true, isDeploymentAdmin: false }, false],
    [{ isAdmin: false, isDeploymentAdmin: true }, false],
    [{ isAdmin: false, isDeploymentAdmin: false }, false],
  ])("for %j shows the all-workspaces report: %s", (who, shown) => {
    Object.assign(view, who);
    render(<UsagePage />);
    expect(!!screen.queryByText("deployment report")).toBe(shown);
  });
});
