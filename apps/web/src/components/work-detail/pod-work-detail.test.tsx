import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { extractWorkLinks } from "@optio/shared";
import { PodWorkDetail } from "./pod-work-detail";

const { getSession, getSessionPrs, chatProps } = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionPrs: vi.fn(),
  chatProps: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api: { getSession, getSessionPrs } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/dynamic", () => ({ default: () => () => <div>Terminal</div> }));
vi.mock("@/hooks/use-session-layout", () => ({
  useSessionLayout: vi.fn(),
  rememberSessionLayout: (s: string) => s,
}));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({ userId: "owner", canMutate: true }),
}));
vi.mock("@/components/local/title-editor", () => ({
  TitleEditor: ({ title }: { title: string }) => <span>{title}</span>,
}));
vi.mock("@/components/session-recovery-status", () => ({ SessionRecoveryStatus: () => null }));
vi.mock("@/components/session-share-button", () => ({ SessionShareButton: () => null }));
vi.mock("@/components/split-pane", () => ({
  SplitPane: ({ left, right }: any) => (
    <>
      {left}
      {right}
    </>
  ),
}));
vi.mock("@/components/session-chat", async () => {
  const { useEffect } = await import("react");
  return {
    SessionChat: (props: any) => {
      chatProps(props);
      const { onLinks } = props;
      useEffect(() => {
        onLinks?.(extractWorkLinks("https://linear.app/acme/issue/ENG-9"));
      }, [onLinks]);
      return <div>Saved conversation</div>;
    },
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([null, "codex"])(
  "shows PR and ticket badges in the header for runtime %s",
  async (agentRuntime) => {
    getSession.mockResolvedValue({
      session: {
        id: "session",
        title: "Pod work",
        state: "active",
        agentRuntime,
        createdAt: new Date().toISOString(),
        links: extractWorkLinks("https://github.com/acme/app/issues/12"),
      },
    });
    getSessionPrs.mockResolvedValue({
      prs: [
        {
          id: "pr",
          prUrl: "https://github.com/acme/app/pull/25",
          prNumber: 25,
          prState: "open",
          prChecksStatus: "passing",
        },
      ],
    });
    render(<PodWorkDetail id="session" />);
    const header = within(await screen.findByRole("banner"));
    expect(await header.findByRole("link", { name: /ENG-9/ })).toHaveAttribute(
      "href",
      "https://linear.app/acme/issue/ENG-9",
    );
    expect(header.getByRole("link", { name: /#25/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/25",
    );
    expect(header.getByRole("link", { name: /acme\/app#12/ })).toBeVisible();
  },
);

it("keeps ended-session history and badges visible in read-only mode", async () => {
  getSession.mockResolvedValue({
    session: {
      id: "ended",
      title: "Finished",
      state: "ended",
      createdAt: new Date().toISOString(),
      links: [],
    },
  });
  getSessionPrs.mockResolvedValue({ prs: [] });
  render(<PodWorkDetail id="ended" />);
  expect(await screen.findByText("Saved conversation")).toBeVisible();
  expect(chatProps.mock.calls.at(-1)?.[0]).toMatchObject({ readOnly: true });
  expect(await screen.findByRole("link", { name: /ENG-9/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: "End Session" })).toBeNull();
});

it("can open a session when PR status lookup fails", async () => {
  getSession.mockResolvedValue({
    session: {
      id: "session",
      title: "Still available",
      state: "ended",
      createdAt: new Date().toISOString(),
    },
  });
  getSessionPrs.mockRejectedValue(new Error("Unavailable"));
  render(<PodWorkDetail id="session" />);
  expect(await screen.findByText("Still available")).toBeVisible();
});
