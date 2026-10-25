import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The account menu holds Help → Using Optio only while a deployment admin has
// the getting-started guide on (Settings → Access): off, it is the default menu.
const mocks = vi.hoisted(() => ({ onboarding: false }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/api-client", () => ({ api: { logout: vi.fn() } }));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    user: { id: "u1", displayName: "Ann", email: "ann@example.com" },
    userId: "u1",
    authDisabled: false,
    isAdmin: false,
    isDeploymentAdmin: false,
  }),
}));
vi.mock("@/hooks/use-deployment-switches", () => ({
  useDeploymentSwitches: () => ({ onboarding: mocks.onboarding, loaded: true }),
}));
vi.mock("./theme-provider", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

import { UserMenu } from "./user-menu";

beforeEach(() => {
  mocks.onboarding = false;
});
afterEach(() => cleanup());

const open = () => fireEvent.click(screen.getByRole("button", { name: "Account menu" }));

describe("UserMenu", () => {
  it("has no Help by default", () => {
    render(<UserMenu />);
    open();
    expect(screen.getByRole("region", { name: "Account settings" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Help" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Using Optio/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Sign out/ })).toBeInTheDocument();
  });

  it("offers Help → Using Optio with the getting-started guide on", () => {
    mocks.onboarding = true;
    render(<UserMenu />);
    open();
    const help = screen.getByRole("navigation", { name: "Help" });
    expect(help).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Using Optio/ })).toHaveAttribute("href", "/help");
  });
});
