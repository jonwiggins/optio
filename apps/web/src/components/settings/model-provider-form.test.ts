import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@optio/shared";
import {
  emptyProviderForm,
  formFromProvider,
  formatModels,
  parseModels,
  podsLabel,
  toCreateInput,
  toUpdateInput,
  toggleAgent,
  validateProviderForm,
  withRegion,
} from "./model-provider-form";

const saved: ModelProvider = {
  id: "p1",
  workspaceId: "ws",
  ownerUserId: null,
  ownerName: null,
  kind: "bedrock",
  name: "Bedrock",
  agents: ["claude-code"],
  region: "us-west-2",
  models: { "claude-code": [{ id: "us.anthropic.claude-opus-5-5", label: "Opus 5.5" }] },
  localAwsProfile: null,
  podCredential: "access-key",
  hasPodCredentials: true,
  mine: false,
  canEdit: true,
  createdAt: "",
  updatedAt: "",
};

describe("model provider form", () => {
  it("starts with Claude Code, us-west-2, and its suggested models; owner by role", () => {
    const f = emptyProviderForm(true);
    expect(f.owner).toBe("workspace");
    expect(emptyProviderForm(false).owner).toBe("me");
    expect(f.models["claude-code"]?.[0].id).toBe("us.anthropic.claude-opus-5-5");
  });

  it("prefills a newly checked agent and moves untouched suggestions with the region", () => {
    const f = toggleAgent(emptyProviderForm(true), "codex", true);
    expect(f.agents).toEqual(["claude-code", "codex"]);
    expect(f.models.codex?.[0].id).toBe("openai.gpt-5.5");
    const eu = withRegion(f, "eu-west-1");
    expect(eu.models["claude-code"]?.[0].id).toBe("eu.anthropic.claude-opus-5-5");
    // Edited lists stay put.
    const edited = { ...f, models: { ...f.models, "claude-code": [{ id: "custom" }] } };
    expect(withRegion(edited, "eu-west-1").models["claude-code"]).toEqual([{ id: "custom" }]);
  });

  it("parses and formats model lines", () => {
    const models = parseModels("a.b | A\n\n  c.d  \n");
    expect(models).toEqual([{ id: "a.b", label: "A" }, { id: "c.d" }]);
    expect(formatModels(models)).toBe("a.b | A\nc.d");
  });

  it("validates", () => {
    const f = emptyProviderForm(true);
    expect(validateProviderForm(f, true)).toMatch(/access key/);
    const ok = { ...f, accessKeyId: "AKIA", secretAccessKey: "s" };
    expect(validateProviderForm(ok, true)).toBeNull();
    expect(validateProviderForm({ ...ok, region: "west" }, true)).toMatch(/Region/);
    expect(validateProviderForm({ ...ok, agents: [] }, true)).toMatch(/agent/);
    expect(validateProviderForm({ ...f, podCredential: "ambient" }, true)).toBeNull();
    // Editing with stored credentials kept needs nothing typed.
    expect(validateProviderForm(formFromProvider(saved), false)).toBeNull();
  });

  it("builds the create body with credentials only when stored ones are wanted", () => {
    const body = toCreateInput({
      ...emptyProviderForm(true),
      accessKeyId: " AKIA ",
      secretAccessKey: "s",
    });
    expect(body).toMatchObject({
      kind: "bedrock",
      owner: "workspace",
      region: "us-west-2",
      localAwsProfile: null,
      credentials: { type: "access-key", accessKeyId: "AKIA", secretAccessKey: "s" },
    });
    expect(
      toCreateInput({ ...emptyProviderForm(true), podCredential: "ambient" }),
    ).not.toHaveProperty("credentials");
  });

  it("update keeps, replaces, or clears the stored credentials", () => {
    const f = formFromProvider(saved);
    expect(toUpdateInput(f, saved)).not.toHaveProperty("credentials");
    expect(toUpdateInput(f, saved)).not.toHaveProperty("owner");
    expect(toUpdateInput({ ...f, credentialAction: "clear" }, saved).credentials).toBeNull();
    expect(
      toUpdateInput(
        { ...f, credentialAction: "replace", podCredential: "bearer-token", bearerToken: "t" },
        saved,
      ).credentials,
    ).toEqual({ type: "bearer-token", bearerToken: "t" });
    // Switching to the pod's IAM role drops what was stored.
    expect(toUpdateInput({ ...f, podCredential: "ambient" }, saved).credentials).toBeNull();
    expect(toUpdateInput({ ...f, owner: "me" }, saved).owner).toBe("me");
  });

  it("labels pod sign-in for the list", () => {
    expect(podsLabel({ podCredential: "bearer-token" })).toBe("Pods: API key");
    expect(podsLabel({ podCredential: "none" })).toBe("Machines only");
  });
});
