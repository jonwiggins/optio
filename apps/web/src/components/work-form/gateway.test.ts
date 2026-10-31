import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@optio/shared";
import { EMPTY_DRAFT } from "./model";
import { gatewayChoices, gatewayFor, picksGateway, withGatewayModel } from "./gateway";

const base: ModelProvider = {
  id: "g-org",
  workspaceId: "ws",
  ownerUserId: null,
  ownerName: null,
  kind: "gateway",
  name: "LiteLLM",
  agents: ["claude-code"],
  region: "",
  models: {
    "claude-code": [
      { id: "claude-old", missing: true },
      { id: "claude-sonnet-internal", efforts: ["low", "high"], defaultEffort: "high" },
    ],
  },
  localAwsProfile: null,
  podCredential: "none",
  hasPodCredentials: false,
  baseUrl: "https://litellm.example.com",
  authHeader: "bearer",
  syncUrl: null,
  lastSyncedAt: null,
  tokenSource: "personal",
  mine: false,
  canEdit: true,
  createdAt: "",
  updatedAt: "",
};
const mine: ModelProvider = { ...base, id: "g-mine", name: "Lab", ownerUserId: "u1", mine: true };
const theirs: ModelProvider = { ...base, id: "g-theirs", ownerUserId: "u2", mine: false };
const bedrock: ModelProvider = { ...base, id: "b1", kind: "bedrock", region: "us-west-2" };
const providers = [bedrock, theirs, mine, base];

const draft = { ...EMPTY_DRAFT, runtime: "claude-code", agentOptions: { claudeModel: "opus" } };

describe("the New work form's gateway (docs/model-gateway.md)", () => {
  it("offers the organization's gateways and yours that serve the runtime", () => {
    expect(gatewayChoices(draft, providers).map((p) => p.id)).toEqual(["g-mine", "g-org"]);
    expect(gatewayChoices({ ...draft, runtime: "codex" }, providers)).toEqual([]);
    expect(gatewayChoices({ ...draft, runtime: "" }, providers)).toEqual([]);
  });

  it("rides the default gateway in a gateway-only deployment, else the organization's first", () => {
    expect(gatewayFor(draft, providers, "g-mine", true)?.id).toBe("g-mine");
    expect(gatewayFor(draft, providers, "gone", true)?.id).toBe("g-org");
    expect(gatewayFor(draft, providers, null, true)?.id).toBe("g-org");
    // The draft uses a gateway when it names one.
    expect(gatewayFor(draft, providers, "g-org", false)).toBeNull();
    const named = { ...draft, agentOptions: { ...draft.agentOptions, modelProvider: "g-mine" } };
    expect(gatewayFor(named, providers, "g-org", false)?.id).toBe("g-mine");
    expect(picksGateway(named, mine)).toBe(true);
    expect(picksGateway(draft, base)).toBe(false);
    // Bedrock picked: no gateway, even in a gateway-only deployment.
    const onBedrock = { ...draft, agentOptions: { ...draft.agentOptions, modelProvider: "b1" } };
    expect(gatewayFor(onBedrock, providers, "g-org", true)).toBeNull();
  });

  it("names a model the gateway serves and drops the context-window option", () => {
    const next = withGatewayModel(
      {
        ...draft,
        agentOptions: { claudeModel: "opus", claudeContextWindow: "1m", claudeEffort: "high" },
      },
      base,
    );
    // The first model still served, never the missing one.
    expect(next.agentOptions).toEqual({
      claudeModel: "claude-sonnet-internal",
      claudeEffort: "high",
    });
    const kept = { ...draft, agentOptions: { claudeModel: "claude-old" } };
    expect(withGatewayModel(kept, base)).toBe(kept);
    expect(withGatewayModel(draft, null)).toBe(draft);
  });
});
