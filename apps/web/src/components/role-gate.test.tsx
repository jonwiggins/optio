import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useCurrentUserStore } from "@/hooks/use-current-user";
import { IfCanMutate, ViewerReadOnlyNotice } from "./role-gate";

// The hook fetches the user on first use when nothing is loaded; keep that
// pending so each test decides the state through the store.
vi.mock("@/lib/api-client", () => ({
  api: { getCurrentUser: vi.fn(() => new Promise(() => {})) },
}));

const signedIn = (workspaceRole: string | null) => ({
  user: {
    id: "u1",
    provider: "github",
    email: "u@example.com",
    displayName: "U",
    avatarUrl: null,
    workspaceId: "w1",
    workspaceRole,
  },
  authDisabled: false,
  loaded: true,
});

describe("IfCanMutate", () => {
  beforeEach(() => {
    useCurrentUserStore.getState().reset();
  });
  afterEach(cleanup);

  it("hides its children from a viewer", () => {
    useCurrentUserStore.setState(signedIn("viewer"));
    render(
      <IfCanMutate>
        <button>New work</button>
      </IfCanMutate>,
    );
    expect(screen.queryByRole("button", { name: "New work" })).toBeNull();
  });

  it("shows them to a member", () => {
    useCurrentUserStore.setState(signedIn("member"));
    render(
      <IfCanMutate>
        <button>New work</button>
      </IfCanMutate>,
    );
    expect(screen.getByRole("button", { name: "New work" })).toBeInTheDocument();
  });

  it("shows them while the user is still unknown and when auth is disabled", () => {
    render(
      <IfCanMutate>
        <button>New work</button>
      </IfCanMutate>,
    );
    expect(screen.getByRole("button", { name: "New work" })).toBeInTheDocument();

    useCurrentUserStore.setState({ ...signedIn("viewer"), authDisabled: true });
    render(
      <IfCanMutate>
        <button>Also new work</button>
      </IfCanMutate>,
    );
    expect(screen.getByRole("button", { name: "Also new work" })).toBeInTheDocument();
  });
});

describe("ViewerReadOnlyNotice", () => {
  it("says why the form is not there", () => {
    render(<ViewerReadOnlyNotice />);
    expect(screen.getByRole("status")).toHaveTextContent("Viewers can't create work");
    expect(screen.getByRole("status")).toHaveTextContent("read-only");
  });
});
