import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { LimitsPanel, type ProviderLimits } from "./limits-panel";

const providers: ProviderLimits[] = [
  {
    key: "claude",
    name: "Claude",
    source: "account, live",
    observedAt: null,
    windows: [{ label: "5h", window: { usedPercent: 22, resetsAt: null } }],
  },
];

describe("LimitsPanel refresh", () => {
  afterEach(() => cleanup());

  it("shows a busy state while refreshing, then an updated marker", async () => {
    let resolve!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<LimitsPanel providers={providers} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /refreshing/i })).toBeDisabled();
    expect(screen.getByText(/checking with Anthropic/i)).toBeInTheDocument();

    resolve();
    await waitFor(() => expect(screen.getByText(/updated just now/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(screen.getByRole("button", { name: /^refresh$/i })).not.toBeDisabled();
  });

  it("surfaces a failure instead of pretending it worked", async () => {
    const onRefresh = vi.fn(() => Promise.reject(new Error("Usage API returned 429")));
    render(<LimitsPanel providers={providers} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(screen.getByText(/429/)).toBeInTheDocument());
    expect(screen.queryByText(/updated just now/i)).not.toBeInTheDocument();
  });

  it("ignores a second click while one is in flight", async () => {
    let resolve!: () => void;
    const onRefresh = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<LimitsPanel providers={providers} onRefresh={onRefresh} />);
    const btn = screen.getByRole("button", { name: /refresh/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(screen.getByText(/updated just now/i)).toBeInTheDocument(), {
      timeout: 2000,
    });
  });
});
