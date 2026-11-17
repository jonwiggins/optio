import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The offline UI (lib/offline-ui.ts): with window.__OPTIO_CONFIG.offlineUi
// no outside image is loaded and no outside link is offered; without it,
// nothing changes.
const user = vi.hoisted(() => ({
  avatarUrl: "https://www.gravatar.com/avatar/0123456789abcdef" as string | null,
}));

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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-client", () => ({
  api: {
    logout: vi.fn(),
    createSecret: vi.fn(),
    listLocalHosts: vi.fn(async () => ({ hosts: [] })),
  },
}));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    user: { id: "u1", displayName: "Ann", email: "ann@example.com", avatarUrl: user.avatarUrl },
    userId: "u1",
    authDisabled: false,
    isAdmin: false,
    isDeploymentAdmin: false,
  }),
}));
vi.mock("@/hooks/use-onboarding", () => ({
  useOnboarding: () => ({ onboarding: false, loaded: true }),
}));
vi.mock("@/components/layout/theme-provider", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

import { UserMenu } from "./layout/user-menu";
import { GitHubTokenBanner } from "./token-refresh-banner";
import { ClusterSummary } from "./dashboard/cluster-summary";
import { GuideMarkdown } from "./help/guide-markdown";

const offline = (on: boolean) => {
  (window as any).__OPTIO_CONFIG = on ? { offlineUi: true } : {};
};

beforeEach(() => {
  user.avatarUrl = "https://www.gravatar.com/avatar/0123456789abcdef";
});
afterEach(() => {
  cleanup();
  delete (window as any).__OPTIO_CONFIG;
});

const avatars = (container: HTMLElement) =>
  [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));

describe("avatars", () => {
  it("load from wherever the sign-in provider said by default", () => {
    offline(false);
    const { container } = render(<UserMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(avatars(container)).toEqual([user.avatarUrl, user.avatarUrl]);
  });

  it("offline, an outside avatar shows the placeholder: no request leaves the network", () => {
    offline(true);
    const { container } = render(<UserMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(avatars(container)).toEqual([]);
    expect(screen.getAllByText("Ann").length).toBeGreaterThan(0);
  });

  it("offline, an avatar the deployment itself serves still shows", () => {
    offline(true);
    user.avatarUrl = `${window.location.origin}/avatars/u1.png`;
    const { container } = render(<UserMenu />);
    expect(avatars(container)).toEqual([user.avatarUrl]);
  });
});

describe("outside links", () => {
  const node = { name: "node-1", cpu: "4", memory: "8Gi", cpuPercent: null, memoryUsedGi: null };
  const showMetrics = () => {
    const view = render(
      <ClusterSummary
        cluster={{
          nodes: [node],
          summary: {
            totalPods: 1,
            runningPods: 1,
            agentPods: 0,
            infraPods: 1,
            totalNodes: 1,
            readyNodes: 1,
          },
        }}
        totalCost={0}
        metricsAvailable={false}
        metricsHistory={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    return view.container.textContent ?? "";
  };

  it("are offered by default", () => {
    offline(false);
    render(<GitHubTokenBanner />);
    expect(
      screen.getByRole("link", { name: /Create GitHub Personal Access Token/ }),
    ).toHaveAttribute("href", expect.stringContaining("https://github.com/settings/tokens/new"));
    cleanup();
    render(<GuideMarkdown source="See [the site](https://www.example.com/docs)." />);
    expect(screen.getByRole("link", { name: "the site" })).toHaveAttribute(
      "href",
      "https://www.example.com/docs",
    );
  });

  it("offline, the token page link is left out and the paste field stays", () => {
    offline(true);
    render(<GitHubTokenBanner />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("GitHub token invalid")).toBeInTheDocument();
  });

  it("offline, the guide's outside links are text and its anchors still links", () => {
    offline(true);
    render(
      <GuideMarkdown source={"See [the site](https://www.example.com/docs) or [below](#below)."} />,
    );
    expect(screen.queryByRole("link", { name: "the site" })).toBeNull();
    expect(screen.getByText(/See the site or/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "below" })).toHaveAttribute("href", "#below");
  });

  it("offline, the metrics-server hint names no outside URL", () => {
    offline(false);
    expect(showMetrics()).toContain(
      "https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml",
    );
    cleanup();

    offline(true);
    const text = showMetrics();
    expect(text).toContain("metrics-server not detected");
    expect(text).toContain("Install metrics-server from your registry mirror");
    expect(text).not.toContain("https://");
  });
});
