import { describe, expect, it } from "vitest";
import { accessSettingsOf, type AccessDraft } from "./oidc-sign-in-form";

const draft = (patch: Partial<AccessDraft> = {}): AccessDraft => ({
  adminGroups: [],
  requiredGroups: [],
  autoJoinOrganization: false,
  defaultRole: "member",
  linkByEmail: false,
  allowedDomains: "",
  enabled: true,
  ...patch,
});

describe("accessSettingsOf", () => {
  it("sends only linkByEmail while every group setting is at its default", () => {
    expect(accessSettingsOf(draft())).toEqual({ linkByEmail: false });
  });

  it("sends groups, organization joining and its role once they are set", () => {
    expect(
      accessSettingsOf(
        draft({
          adminGroups: ["Optio Admins"],
          requiredGroups: ["Engineering"],
          autoJoinOrganization: true,
          defaultRole: "viewer",
          linkByEmail: true,
        }),
      ),
    ).toEqual({
      adminGroups: ["Optio Admins"],
      requiredGroups: ["Engineering"],
      autoJoinOrganization: true,
      defaultRole: "viewer",
      linkByEmail: true,
    });
  });
});
