import { describe, expect, it } from "vitest";
import { joinAction, standingOf } from "./standing";

describe("a team row from the viewer's side", () => {
  it("names where they stand", () => {
    expect(standingOf({ myRole: "admin", myStatus: "active" })).toBe("admin");
    expect(standingOf({ myRole: "member", myStatus: "active" })).toBe("member");
    expect(standingOf({ myRole: "member", myStatus: "requested" })).toBe("requested");
    expect(standingOf({ myRole: null, myStatus: "denied" })).toBe("denied");
    expect(standingOf({ myRole: null, myStatus: null })).toBe("none");
  });

  it("offers the one button the server will honour", () => {
    expect(joinAction({ myRole: "member", myStatus: "active", joinPolicy: "open" }).kind).toBe(
      "leave",
    );
    expect(joinAction({ myRole: null, myStatus: "requested", joinPolicy: "request" })).toEqual({
      kind: "cancel",
      label: "Cancel request",
    });
    expect(joinAction({ myRole: null, myStatus: null, joinPolicy: "open" })).toEqual({
      kind: "join",
      label: "Join",
    });
    expect(joinAction({ myRole: null, myStatus: null, joinPolicy: "request" })).toEqual({
      kind: "request",
      label: "Request to join",
    });
    expect(joinAction({ myRole: null, myStatus: "denied", joinPolicy: "request" }).label).toBe(
      "Ask again",
    );
    expect(joinAction({ myRole: null, myStatus: null, joinPolicy: "closed" }).kind).toBe("none");
  });
});
