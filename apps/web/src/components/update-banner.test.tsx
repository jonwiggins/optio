import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const getClusterVersion = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getClusterVersion: () => getClusterVersion(),
    triggerClusterUpdate: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { UpdateBanner } from "./update-banner";

beforeEach(() => {
  getClusterVersion.mockReset();
});

afterEach(cleanup);

describe("UpdateBanner", () => {
  it("offers a newer release with the Update button", async () => {
    getClusterVersion.mockResolvedValue({
      current: "1.0.0",
      latest: "1.2.0",
      updateAvailable: true,
      updateCheck: true,
    });
    render(<UpdateBanner />);

    expect(await screen.findByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("shows nothing when the deployment turned updates off", async () => {
    // Even a stale or proxied answer that claims an update must not bring the button back.
    getClusterVersion.mockResolvedValue({
      current: "1.0.0",
      latest: "1.2.0",
      updateAvailable: true,
      updateCheck: false,
    });
    const { container } = render(<UpdateBanner />);

    await waitFor(() => expect(getClusterVersion).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });
});
