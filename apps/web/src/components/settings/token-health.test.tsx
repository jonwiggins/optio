import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Settings → My tokens → Health.

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const list = vi.fn();
const checkMine = vi.fn();
vi.mock("@/lib/credential-health-api", () => ({
  credentialHealthApi: { list: () => list(), checkMine: () => checkMine() },
}));

import { TokenHealth, expiryText } from "./token-health";

beforeEach(() => {
  list.mockReset();
  checkMine.mockReset();
});
afterEach(() => cleanup());

const row = (over: Record<string, unknown>) => ({
  key: "k",
  kind: "gateway",
  label: "Gateway token · Corp (LiteLLM)",
  scope: "person",
  status: "ok",
  reason: null,
  expiresAt: null,
  checkedAt: "2026-10-24T12:00:00Z",
  details: {},
  ...over,
});

describe("TokenHealth", () => {
  it("shows each token's status, reason and expiry, worst first as the API sends them", async () => {
    list.mockResolvedValue({
      intervalMinutes: 15,
      checks: [
        row({ key: "a", status: "error", reason: "Over budget until 2026-11-01 00:00 UTC" }),
        row({
          key: "b",
          kind: "gitlab",
          label: "GitLab token",
          status: "warning",
          expiresAt: "2026-10-31T00:00:00Z",
          scope: "organization",
        }),
      ],
    });
    render(<TokenHealth />);
    expect(await screen.findByText("Not working")).toBeInTheDocument();
    expect(screen.getByText("Over budget until 2026-11-01 00:00 UTC")).toBeInTheDocument();
    expect(screen.getByText("expires 2026-10-31")).toBeInTheDocument();
    expect(screen.getByText("(the organization's)")).toBeInTheDocument();
    expect(expiryText({ expiresAt: null })).toBeNull();
  });

  it("checks the viewer's tokens now and shows the result", async () => {
    list.mockResolvedValueOnce({ intervalMinutes: 15, checks: [] });
    list.mockResolvedValueOnce({ intervalMinutes: 15, checks: [row({ status: "ok" })] });
    checkMine.mockResolvedValue({ checks: [] });
    render(<TokenHealth />);
    expect(await screen.findByText(/Nothing checked yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Check now"));
    await waitFor(() => expect(checkMine).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("health-ok")).toBeInTheDocument();
  });
});
