import { describe, expect, it } from "vitest";
import { secretApiScope } from "./connections-list";

describe("secretApiScope", () => {
  it("replaces a secret at the scope it came from", () => {
    expect(
      secretApiScope({ scope: "repo", detail: "https://github.com/a/b", ownerUserId: null }),
    ).toBe("https://github.com/a/b");
    expect(secretApiScope({ scope: "private", detail: "Secret", ownerUserId: "u1" })).toBe("user");
    // The workspace's own organization secret stays the workspace's.
    expect(secretApiScope({ scope: "workspace", detail: "Secret", ownerUserId: null })).toBe(
      "workspace",
    );
    // The deployment's (a deployment admin's).
    expect(secretApiScope({ scope: "global", detail: "Secret", ownerUserId: null })).toBe("global");
  });
});
