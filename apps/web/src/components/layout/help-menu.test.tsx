import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  userId: "u1" as string | null,
  onboarding: true,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({ userId: mocks.userId }),
}));
vi.mock("@/hooks/use-deployment-switches", () => ({
  useDeploymentSwitches: () => ({ onboarding: mocks.onboarding, loaded: true }),
}));

import { HelpMenu } from "./help-menu";
import { useGettingStartedStore } from "@/components/dashboard/getting-started-store";

beforeEach(() => {
  mocks.userId = "u1";
  mocks.onboarding = true;
  window.localStorage.clear();
  useGettingStartedStore.setState({ hidden: {} });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HelpMenu with the getting-started guide off (the default)", () => {
  it("renders nothing: no guide link, no checklist", () => {
    mocks.onboarding = false;
    const { container } = render(<HelpMenu />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("link", { name: /Using Optio/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Getting-started checklist/ })).toBeNull();
  });
});

describe("HelpMenu (the account menu's Help), the guide on", () => {
  it("links to the guide", () => {
    const onNavigate = vi.fn();
    render(<HelpMenu onNavigate={onNavigate} />);
    const link = screen.getByRole("link", { name: /Using Optio/ });
    expect(link).toHaveAttribute("href", "/help");
    link.addEventListener("click", (e) => e.preventDefault()); // jsdom doesn't navigate
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalled();
  });

  it("brings the hidden checklist back and opens the Overview", () => {
    useGettingStartedStore.getState().dismiss("u1");
    expect(useGettingStartedStore.getState().isHidden("u1")).toBe(true);
    render(<HelpMenu />);
    fireEvent.click(screen.getByRole("button", { name: /Getting-started checklist/ }));
    expect(useGettingStartedStore.getState().isHidden("u1")).toBe(false);
    expect(window.localStorage.getItem("optio.gettingStarted.hidden.u1")).toBeNull();
    expect(mocks.push).toHaveBeenCalledWith("/");
  });

  it("offers no checklist without a person (sign-in off)", () => {
    mocks.userId = null;
    render(<HelpMenu />);
    expect(screen.queryByRole("button", { name: /Getting-started checklist/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Using Optio/ })).toBeInTheDocument();
  });
});
