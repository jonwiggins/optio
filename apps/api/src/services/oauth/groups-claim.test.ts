import type { Profile } from "@node-saml/node-saml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BitbucketOAuthProvider } from "./bitbucket.js";
import { claimPresent } from "./oidc.js";
import { samlProfileToUser } from "./saml.js";

/**
 * An absent groups claim is no statement about the person's groups
 * (`groupsClaimMissing`), unlike a present, empty one: sign-in revokes group
 * access only on the latter (routes/auth.ts, completeSignIn).
 */
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.restoreAllMocks());

describe("an absent groups claim is marked missing", () => {
  it("OIDC: tells a missing claim from an empty one, by name or by path", () => {
    expect(claimPresent({ groups: [] }, "groups")).toBe(true);
    expect(claimPresent({ groups: "" }, "groups")).toBe(true);
    expect(claimPresent({ sub: "x" }, "groups")).toBe(false);
    expect(claimPresent({ groups: null }, "groups")).toBe(false);
    expect(claimPresent({ realm_access: { roles: [] } }, "realm_access.roles")).toBe(true);
    expect(claimPresent({ realm_access: {} }, "realm_access.roles")).toBe(false);
    expect(claimPresent({}, "realm_access.roles")).toBe(false);
  });

  it("SAML: no groups attribute is marked missing, an empty one is not", () => {
    const user = (attributes: Record<string, unknown>) =>
      samlProfileToUser(
        { issuer: "https://idp.example.test", nameID: "123", attributes } as unknown as Profile,
        {},
      );
    expect(user({ email: "a@example.test" })).toMatchObject({
      groups: [],
      groupsClaimMissing: true,
    });
    expect(user({ email: "a@example.test", groups: [] }).groupsClaimMissing).toBeUndefined();
    expect(user({ email: "a@example.test", Groups: ["Readers"] })).toMatchObject({
      groups: ["Readers"],
    });
    expect(
      user({ email: "a@example.test", Groups: ["Readers"] }).groupsClaimMissing,
    ).toBeUndefined();
  });

  it("Bitbucket: a failed workspaces read is marked missing", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ uuid: "{123}" }))
      .mockResolvedValueOnce(
        json({ values: [{ email: "alice@example.test", is_primary: true, is_confirmed: true }] }),
      )
      .mockResolvedValueOnce(json({}, 403));
    expect(await new BitbucketOAuthProvider().fetchUser("token")).toMatchObject({
      groups: [],
      groupsClaimMissing: true,
    });
  });
});
