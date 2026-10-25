import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { LogLine } from "./log-viewer";
import { ThinkingFold } from "./thinking-fold";
import type { LogEntry } from "@/hooks/use-logs";

afterEach(cleanup);

describe("ThinkingFold", () => {
  const entries: LogEntry[] = [
    {
      content: "first thought",
      stream: "stdout",
      timestamp: "2026-10-22T10:00:00.000Z",
      logType: "thinking",
      metadata: { thinkingTokens: 30 },
    },
    {
      content: "second thought",
      stream: "stdout",
      timestamp: "2026-10-22T10:00:01.000Z",
      logType: "thinking",
      metadata: { thinkingTokens: 12 },
    },
  ];

  it("folds the blocks into one collapsed row that opens on click", () => {
    render(
      <ThinkingFold entries={entries} renderEntry={(e) => <LogLine log={e} searchQuery="" />} />,
    );
    const toggle = screen.getByRole("button", { name: "Thinking (2 blocks · 42 tokens)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("first thought")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("first thought")).toBeInTheDocument();
    expect(screen.getByText("second thought")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText("second thought")).not.toBeInTheDocument();
  });

  it("opens every fold with the viewer's Thinking toggle", () => {
    const { rerender } = render(
      <ThinkingFold entries={entries} defaultOpen renderEntry={(e) => <span>{e.content}</span>} />,
    );
    expect(screen.getByText("first thought")).toBeInTheDocument();
    rerender(
      <ThinkingFold
        entries={entries}
        defaultOpen={false}
        renderEntry={(e) => <span>{e.content}</span>}
      />,
    );
    expect(screen.queryByText("first thought")).not.toBeInTheDocument();
  });
});
