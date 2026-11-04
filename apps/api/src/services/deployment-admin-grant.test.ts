import { describe, expect, it } from "vitest";
import {
  deploymentAdminsAdministerAllWorkspaces,
  envDeploymentAdmins,
  holdsDeploymentAdmin,
} from "./deployment-admin-grant.js";

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe("envDeploymentAdmins", () => {
  it("reads a comma-separated, case-insensitive list", () => {
    expect([...envDeploymentAdmins(env({ OPTIO_DEPLOYMENT_ADMINS: " A@x.io, ,b@x.io " }))]).toEqual(
      ["a@x.io", "b@x.io"],
    );
    expect(envDeploymentAdmins(env({})).size).toBe(0);
  });
});

describe("holdsDeploymentAdmin", () => {
  const row = { deploymentAdmin: false, email: "Ops@Acme.io", emailVerified: true };
  it("holds by the stored flag", () => {
    expect(holdsDeploymentAdmin({ ...row, deploymentAdmin: true }, env({}))).toBe(true);
  });
  it("holds by the environment's list only for a verified email", () => {
    const listed = env({ OPTIO_DEPLOYMENT_ADMINS: "ops@acme.io" });
    expect(holdsDeploymentAdmin(row, listed)).toBe(true);
    expect(holdsDeploymentAdmin({ ...row, emailVerified: false }, listed)).toBe(false);
    expect(holdsDeploymentAdmin(row, env({}))).toBe(false);
  });
});

describe("deploymentAdminsAdministerAllWorkspaces", () => {
  it("is off unless the environment says true", () => {
    const on = (v: string) =>
      deploymentAdminsAdministerAllWorkspaces(env({ OPTIO_DEPLOYMENT_ADMINS_ALL_WORKSPACES: v }));
    expect(deploymentAdminsAdministerAllWorkspaces(env({}))).toBe(false);
    for (const v of ["true", "TRUE", "1", "yes", " on "]) expect(on(v)).toBe(true);
    for (const v of ["", "false", "0", "no", "admins"]) expect(on(v)).toBe(false);
  });
});
