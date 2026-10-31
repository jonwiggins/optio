import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// The sidebar is the default one unless a deployment admin turns teams on
// (Settings → Access → Teams): then Teams joins the Library.
const mocks = vi.hoisted(() => ({ teams: false }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/hooks/use-deployment-switches", () => ({
  useDeploymentSwitches: () => ({
    teams: mocks.teams,
    loaded: true,
  }),
}));

import { SidebarNavigation } from "./sidebar-navigation";
import { useNavStore } from "./nav-store";

beforeEach(() => {
  mocks.teams = false;
  useNavStore.setState({ collapsed: [] });
});
afterEach(() => cleanup());

const links = () =>
  within(screen.getByRole("navigation", { name: "Main navigation" }))
    .getAllByRole("link")
    .map((a) => a.textContent?.trim());

describe("SidebarNavigation", () => {
  it("has the default entries, and no Teams, with teams off (the default)", () => {
    render(<SidebarNavigation />);
    expect(links()).not.toContain("Teams");
    expect(links()).toEqual(
      expect.arrayContaining(["Overview", "Work", "Reviews", "Inbox", "Repos", "Connections"]),
    );
  });

  it("lists Teams in the Library with teams on", () => {
    mocks.teams = true;
    render(<SidebarNavigation />);
    const teams = screen.getByRole("link", { name: /Teams/ });
    expect(teams).toHaveAttribute("href", "/teams");
    // Right after Connections, at the Library's end.
    const all = links();
    expect(all.indexOf("Teams")).toBe(all.indexOf("Connections") + 1);
  });
});
