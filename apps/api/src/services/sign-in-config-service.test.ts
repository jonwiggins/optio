import { afterEach, describe, expect, it } from "vitest";
import { domainDecision, envDeploymentAdmins } from "./sign-in-config-service.js";

describe("domainDecision — who may sign in under the allowed domains", () => {
  const acme = ["acme.com", "Acme.io"];

  it("allows anyone when no domain is set", () => {
    expect(domainDecision({ email: "x@gmail.com", emailVerified: false }, [])).toBe("allowed");
  });

  it("allows a Workspace account whose hd and verified email are listed (case-insensitively)", () => {
    expect(
      domainDecision({ email: "a@ACME.com", emailVerified: true, hostedDomain: "acme.com" }, acme),
    ).toBe("allowed");
    expect(
      domainDecision({ email: "a@acme.io", emailVerified: true, hostedDomain: "ACME.IO" }, acme),
    ).toBe("allowed");
  });

  it("refuses an account from another Workspace, whatever its email says", () => {
    expect(
      domainDecision({ email: "a@acme.com", emailVerified: true, hostedDomain: "evil.com" }, acme),
    ).toBe("domain_not_allowed");
  });

  it("refuses a consumer account (no hd) unless its verified email is on the list", () => {
    expect(domainDecision({ email: "a@gmail.com", emailVerified: true }, acme)).toBe(
      "domain_not_allowed",
    );
    // A provider that doesn't send hd (GitHub, OIDC) still passes on the verified email.
    expect(domainDecision({ email: "a@acme.com", emailVerified: true }, acme)).toBe("allowed");
  });

  it("refuses an unverified email — the domain can't be trusted", () => {
    expect(domainDecision({ email: "a@acme.com", emailVerified: false }, acme)).toBe(
      "unverified_email",
    );
    expect(domainDecision({ email: "a@acme.com" }, acme)).toBe("unverified_email");
  });
});

describe("envDeploymentAdmins", () => {
  const prior = process.env.OPTIO_DEPLOYMENT_ADMINS;
  afterEach(() => {
    if (prior === undefined) delete process.env.OPTIO_DEPLOYMENT_ADMINS;
    else process.env.OPTIO_DEPLOYMENT_ADMINS = prior;
  });

  it("parses a comma list, trimmed and lower-cased", () => {
    process.env.OPTIO_DEPLOYMENT_ADMINS = " Ops@Acme.com, jon@acme.com ,, ";
    expect([...envDeploymentAdmins()]).toEqual(["ops@acme.com", "jon@acme.com"]);
  });

  it("is empty when unset", () => {
    delete process.env.OPTIO_DEPLOYMENT_ADMINS;
    expect(envDeploymentAdmins().size).toBe(0);
  });
});
