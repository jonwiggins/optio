import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const logout = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ api: { logout } }));

import { NoWorkspace } from "./no-workspace";
import { viewOf } from "@/hooks/use-current-user";

afterEach(cleanup);

const user = {
  id: "u1",
  provider: "google",
  email: "newcomer@acme.test",
  displayName: "Newcomer",
  avatarUrl: null,
  workspaceId: null,
  workspaceRole: null,
};

describe("signed in, in no workspace", () => {
  it("says to ask a workspace admin, and can sign out", async () => {
    render(<NoWorkspace user={user} />);
    expect(screen.getByRole("heading", { name: /aren.t in a workspace yet/ })).toBeInTheDocument();
    expect(screen.getByText(/newcomer@acme\.test/)).toBeInTheDocument();
    expect(screen.getByText(/Ask a workspace admin to add you/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  it("gets no workspace role (the server answers 403 to everything else)", () => {
    const view = viewOf({ user, authDisabled: false, loaded: true });
    expect(view.isAdmin).toBe(false);
    expect(view.isViewer).toBe(false);
  });
});
