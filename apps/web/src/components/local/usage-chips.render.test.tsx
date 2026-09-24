import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

const getUsage = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getUsage: (...args: unknown[]) => getUsage(...args) },
}));
vi.mock("sonner", () => ({ toast: { message: vi.fn() } }));

import { SessionLimitsPills } from "./usage-chips";

const recentCodex = () => ({
  primary: {
    usedPercent: 42,
    windowMinutes: 300,
    resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  },
  secondary: {
    usedPercent: 18,
    windowMinutes: 10080,
    resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  },
  planType: "pro",
  observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
});

const host = (codex: unknown) => ({ name: "MacBook-Pro", agentLimits: codex ? { codex } : null });
const pills = (el: HTMLElement) =>
  [...el.querySelectorAll("[data-usage-provider]")].map((n) =>
    n.getAttribute("data-usage-provider"),
  );

beforeEach(() => {
  getUsage.mockReset();
  getUsage.mockResolvedValue({
    usage: {
      available: true,
      fiveHour: { utilization: 12, resetsAt: null },
      sevenDay: { utilization: 30, resetsAt: null },
    },
  });
});

afterEach(() => cleanup());

describe("SessionLimitsPills", () => {
  it("shows Codex's limits, not Claude's, in a Codex session", async () => {
    const { container, getAllByText, getByText } = render(
      <SessionLimitsPills
        terminal={{ spec: { kind: "agent", agent: "codex" } }}
        host={host(recentCodex())}
      />,
    );
    expect(pills(container)).toEqual(["codex"]);
    // On the pill and in its hover card.
    expect(getAllByText("42%")).toHaveLength(2);
    expect(getByText(/Pro plan · as of .* on MacBook-Pro/)).toBeInTheDocument();
  });

  it("shows Claude's in a Claude Code session", async () => {
    const { container } = render(
      <SessionLimitsPills
        terminal={{ spec: { kind: "agent", agent: "claude-code" } }}
        host={host(recentCodex())}
      />,
    );
    await waitFor(() => expect(pills(container)).toEqual(["claude"]));
  });

  it("adds Codex's in a plain terminal when Codex ran there this window", async () => {
    const { container } = render(
      <SessionLimitsPills terminal={{ spec: { kind: "shell" } }} host={host(recentCodex())} />,
    );
    await waitFor(() => expect(pills(container)).toEqual(["claude", "codex"]));
  });

  it("leaves a stale Codex snapshot out of a plain terminal", async () => {
    const stale = {
      ...recentCodex(),
      observedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    };
    const { container } = render(
      <SessionLimitsPills terminal={{ spec: { kind: "shell" } }} host={host(stale)} />,
    );
    await waitFor(() => expect(pills(container)).toEqual(["claude"]));
  });

  it("shows nothing for Codex in a Codex session before its first turn logged limits", () => {
    const { container } = render(
      <SessionLimitsPills
        terminal={{ spec: { kind: "agent", agent: "codex" } }}
        host={host(null)}
      />,
    );
    expect(pills(container)).toEqual([]);
  });
});
