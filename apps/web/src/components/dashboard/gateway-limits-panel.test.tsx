import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { GatewayUsage } from "@/lib/api-client";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/api-client", () => ({ api: { getMyGatewayUsage: vi.fn() } }));

import { GatewayLimitsPanel, budgetLine, collectGatewayLimits } from "./gateway-limits-panel";

afterEach(() => cleanup());

const usage: GatewayUsage = {
  gateway: { id: "g1", name: "LiteLLM", baseUrl: "https://litellm.example.com" },
  personal: {
    hasToken: true,
    keyInfo: { spend: 25, maxBudget: 100, budgetResetAt: null, keyAlias: "jon" },
  },
  teams: [
    { teamId: "t1", name: "Platform", hasToken: true, keyInfo: null },
    { teamId: "t2", name: "Data", hasToken: false, keyInfo: null },
  ],
  organization: { hasToken: false, keyInfo: null },
};

describe("GatewayLimitsPanel (gateway-only Overview)", () => {
  it("shows the viewer's key spend against its budget, and their teams'", async () => {
    render(<GatewayLimitsPanel load={async () => usage} />);
    expect(await screen.findByTestId("gateway-limits")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("$25.00 of $100.00")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    // A team with a token but no budget the gateway reports: the row, no meter.
    expect(screen.getByText("Platform")).toBeInTheDocument();
    expect(screen.getByText("Budget unknown — the gateway doesn't report one")).toBeInTheDocument();
    // A team without a token, and an organization without one, aren't rows.
    expect(screen.queryByText("Data")).not.toBeInTheDocument();
    expect(screen.queryByText("Organization")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gateway-no-token")).not.toBeInTheDocument();
  });

  it("points to Settings → My tokens when the viewer has none", async () => {
    render(
      <GatewayLimitsPanel
        load={async () => ({ ...usage, personal: { hasToken: false, keyInfo: null } })}
      />,
    );
    const empty = await screen.findByTestId("gateway-no-token");
    expect(empty).toHaveTextContent("No token yet — add one under Settings → My tokens.");
    expect(screen.getByRole("link", { name: "Settings → My tokens" })).toHaveAttribute(
      "href",
      "/settings#my-tokens",
    );
  });

  it("renders nothing without a gateway, and surfaces a failed read", async () => {
    const { container, unmount } = render(
      <GatewayLimitsPanel load={async () => ({ ...usage, gateway: null })} />,
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    unmount();
    render(<GatewayLimitsPanel load={async () => Promise.reject(new Error("502 from LiteLLM"))} />);
    // A failed first read has no gateway to show either: quiet, not a crash.
    await waitFor(() => expect(screen.queryByTestId("gateway-limits")).not.toBeInTheDocument());
  });

  it("folds the usage into rows and budget lines", () => {
    const rows = collectGatewayLimits({
      ...usage,
      organization: {
        hasToken: true,
        keyInfo: { spend: 1, maxBudget: null, budgetResetAt: null, keyAlias: null },
      },
    });
    expect(rows.map((r) => r.key)).toEqual(["me", "team:t1", "team:t2", "org"]);
    expect(budgetLine(rows[3].keyInfo)).toEqual({ text: "$1.00 spent · no budget", percent: null });
    expect(budgetLine(usage.personal.keyInfo)).toEqual({ text: "$25.00 of $100.00", percent: 25 });
    expect(budgetLine(null).percent).toBeNull();
  });
});
