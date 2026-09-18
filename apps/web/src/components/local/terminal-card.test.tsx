import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  TerminalCard,
  LocalStateBadge,
  dirTail,
  attentionLabel,
  statusDescriptor,
} from "./terminal-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

const noop = async () => {};

const makeTerminal = (overrides: Record<string, unknown> = {}) => ({
  id: "t-1",
  hostId: "h-1",
  title: "fix flaky tests",
  dir: "/Users/jon/repos/optio",
  state: "running",
  pendingReason: null,
  exitCode: null,
  errorMessage: null,
  attentionState: "working",
  attentionReason: null,
  spawnedBy: "manual",
  preview: "$ pnpm test\nPASS src/foo.test.ts",
  lastActivityAt: new Date().toISOString(),
  ...overrides,
});

describe("dirTail", () => {
  it("keeps the last two path segments", () => {
    expect(dirTail("/Users/jon/repos/optio")).toBe("repos/optio");
    expect(dirTail("/srv")).toBe("srv");
  });
});

describe("attentionLabel", () => {
  it("maps known reasons and falls back", () => {
    expect(attentionLabel("stop")).toBe("waiting for you");
    expect(attentionLabel("bell")).toBe("rang the bell");
    expect(attentionLabel(null)).toBe("needs you");
  });
});

const running = { state: "running", attentionState: "working" };

describe("statusDescriptor", () => {
  it("is a single purple dot for a working terminal with a healthy stream", () => {
    const s = statusDescriptor(running, "connected");
    expect(s.label).toBe("Working");
    expect(s.dot).toBe("bg-primary");
    expect(s.detail).toBeNull();
  });

  it("takes the stream's color and names it when the stream is unhealthy", () => {
    const s = statusDescriptor(running, "reconnecting");
    expect(s.label).toBe("Working");
    expect(s.dot).toContain("bg-warning");
    expect(s.dot).toContain("animate-pulse");
    expect(s.detail).toBe("Stream reconnecting…");

    const d = statusDescriptor(running, "disconnected");
    expect(d.dot).toBe("bg-error");
    expect(d.detail).toBe("Stream disconnected");
  });

  it("appends the stream note to an existing detail", () => {
    const s = statusDescriptor(
      { state: "running", attentionState: "needs_you", attentionReason: "stop" },
      "connecting",
    );
    expect(s.label).toBe("Needs you");
    expect(s.detail).toMatch(/ · Stream connecting…$/);
  });

  it("ignores stream health once the process is gone", () => {
    const s = statusDescriptor({ state: "exited", exitCode: 0 }, "disconnected");
    expect(s.label).toBe("Completed");
    expect(s.dot).toBe("bg-success");
  });

  it("uses the session scale: green completed, grey killed/error, yellow needs you", () => {
    expect(statusDescriptor({ state: "exited", exitCode: null })).toMatchObject({
      label: "Killed",
      dot: "bg-text-muted/30",
    });
    expect(statusDescriptor({ state: "exited", exitCode: 1 })).toMatchObject({
      label: "Exited",
      dot: "bg-text-muted/30",
      detail: "exit code 1",
    });
    expect(statusDescriptor({ state: "error", errorMessage: "boom" })).toMatchObject({
      label: "Error",
      dot: "bg-text-muted/30",
      detail: "boom",
    });
    expect(
      statusDescriptor({ state: "exited", exitCode: 0, attentionState: "needs_you" }),
    ).toMatchObject({ label: "Finished", dot: "bg-warning animate-pulse" });
  });
});

describe("LocalStateBadge", () => {
  it("labels a held pending terminal", () => {
    render(
      <LocalStateBadge terminal={makeTerminal({ state: "pending", pendingReason: "hold" })} />,
    );
    expect(screen.getByText("Held")).toBeInTheDocument();
  });

  it("labels an offline-parked pending terminal", () => {
    render(
      <LocalStateBadge
        terminal={makeTerminal({ state: "pending", pendingReason: "host_offline" })}
      />,
    );
    expect(screen.getByText("Host offline")).toBeInTheDocument();
  });
});

describe("TerminalCard", () => {
  it("renders title, host, dir tail and preview", () => {
    render(
      <TerminalCard
        terminal={makeTerminal()}
        hostName="macbook"
        onStart={noop}
        onKill={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText("fix flaky tests")).toBeInTheDocument();
    expect(screen.getByText("macbook")).toBeInTheDocument();
    expect(screen.getByText("repos/optio")).toBeInTheDocument();
    expect(screen.getByText(/pnpm test/)).toBeInTheDocument();
  });

  it("shows a Start button for a held pending terminal", () => {
    render(
      <TerminalCard
        terminal={makeTerminal({ state: "pending", pendingReason: "hold" })}
        onStart={noop}
        onKill={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText("Start")).toBeInTheDocument();
  });

  it("shows the exit code for an exited terminal", () => {
    render(
      <TerminalCard
        terminal={makeTerminal({ state: "exited", exitCode: 1, attentionState: "idle" })}
        onStart={noop}
        onKill={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText("exit 1")).toBeInTheDocument();
  });

  it("shows a Kill button while running", () => {
    render(<TerminalCard terminal={makeTerminal()} onStart={noop} onKill={noop} onDelete={noop} />);
    expect(screen.getByText("Kill")).toBeInTheDocument();
  });
});
