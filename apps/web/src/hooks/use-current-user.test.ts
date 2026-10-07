import { describe, expect, it } from "vitest";
import { viewOf, type CurrentUser } from "./use-current-user";

const user = (workspaceRole: string | null): CurrentUser => ({
  id: "u1",
  provider: "github",
  email: "u@example.com",
  displayName: "U",
  avatarUrl: null,
  workspaceId: "w1",
  workspaceRole,
});

describe("viewOf: who may create and change work", () => {
  it("viewers are read-only", () => {
    const v = viewOf({ user: user("viewer"), authDisabled: false, loaded: true });
    expect(v.isViewer).toBe(true);
    expect(v.canMutate).toBe(false);
    expect(v.isAdmin).toBe(false);
  });

  it("members and admins may", () => {
    expect(viewOf({ user: user("member"), authDisabled: false, loaded: true }).canMutate).toBe(
      true,
    );
    expect(viewOf({ user: user("admin"), authDisabled: false, loaded: true }).canMutate).toBe(true);
  });

  it("an unknown user may, so nothing flickers while loading or on auth-disabled installs", () => {
    const pending = viewOf({ user: null, authDisabled: false, loaded: false });
    expect(pending.canMutate).toBe(true);
    expect(pending.isViewer).toBe(false);
    const noRole = viewOf({ user: user(null), authDisabled: false, loaded: true });
    expect(noRole.canMutate).toBe(true);
  });

  it("auth disabled allows everything, whatever role the placeholder user carries", () => {
    const v = viewOf({ user: user("viewer"), authDisabled: true, loaded: true });
    expect(v.canMutate).toBe(true);
    expect(v.isViewer).toBe(false);
    expect(v.isAdmin).toBe(true);
  });
});
