import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MODEL_PROVIDER_OPTION_KEY, type AgentResult } from "@optio/shared";

// ── Mocks ───────────────────────────────────────────────────────────────────

/** The rows a `db.select()…where()` chain resolves to (a Job run's or review's scope). */
const mockRows = vi.fn<() => Promise<unknown[]>>(async () => []);
vi.mock("../db/client.js", () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.innerJoin = () => c;
    c.where = () => mockRows();
    return c;
  };
  return { db: { select: () => chain() } };
});

const mockDefaultGateway = vi.fn();
vi.mock("./model-gateway-service.js", () => ({
  defaultGateway: (...args: unknown[]) => mockDefaultGateway(...args),
}));

const mockProviderRow = vi.fn();
vi.mock("./model-provider-service.js", () => ({
  getModelProviderRow: (...args: unknown[]) => mockProviderRow(...args),
}));

vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { logger } from "../logger.js";
import {
  gatewayPriceCatalog,
  priceAtCatalog,
  priceRun,
  pricedUsage,
  withPriceCatalog,
} from "./usage-pricing.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const GATEWAY_ID = "11111111-1111-4111-8111-111111111111";
const WS_ID = "22222222-2222-4222-8222-222222222222";

const large = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const gateway = {
  id: GATEWAY_ID,
  kind: "gateway" as const,
  name: "Corp LiteLLM",
  models: {
    "claude-code": [
      { id: "acme-coder-large", label: "Large", prices: large, role: "sonnet" as const },
      { id: "acme-haiku", prices: { input: 1, output: 5 } },
      { id: "acme-free" },
    ],
    opencode: [
      { id: "acme-coder-large", prices: large },
      { id: "acme-gpt", prices: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 } },
    ],
  },
};
const bedrock = {
  id: "b1",
  kind: "bedrock" as const,
  models: { "claude-code": [{ id: "claude-sonnet-5" }] },
};

/** A Claude Code result: tokens per model, and its own guess at the cost. */
const result: AgentResult = {
  success: true,
  summary: "done",
  costUsd: 0.42,
  costBasis: "reported",
  model: "acme-coder-large[1m]",
  inputTokens: 1330,
  outputTokens: 60,
  cacheReadTokens: 1000,
  cacheWriteTokens: 200,
  modelUsage: {
    "acme-coder-large": {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
      costUsd: 0.4,
    },
    "acme-haiku": { inputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
};
// large: 100*3 + 50*15 + 1000*0.3 + 200*3.75 = 2100; haiku: 30*1 + 10*5 = 80 → 2180 / 1e6
const ESTIMATED = 0.00218;

beforeEach(() => {
  vi.clearAllMocks();
  mockRows.mockResolvedValue([]);
  mockDefaultGateway.mockResolvedValue(null);
  // Model access unset: the default (`any`).
  vi.stubEnv("OPTIO_MODEL_ACCESS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("priceAtCatalog", () => {
  it("sums each model's tokens at the catalog's prices and names the busiest model", () => {
    const priced = priceAtCatalog(gatewayPriceCatalog(gateway), result.modelUsage!);
    expect(priced.costBasis).toBe("estimated");
    expect(priced.costUsd).toBeCloseTo(ESTIMATED, 9);
    expect(priced.model).toBe("acme-coder-large");
    expect(priced.perModel).toEqual([
      expect.objectContaining({ model: "acme-coder-large", costUsd: expect.closeTo(0.0021, 9) }),
      expect.objectContaining({ model: "acme-haiku", costUsd: expect.closeTo(0.00008, 9) }),
    ]);
  });

  it("leaves the run unknown (never zero) when any model it called has no prices", () => {
    const priced = priceAtCatalog(gatewayPriceCatalog(gateway), {
      "acme-coder-large": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      "acme-free": { inputTokens: 500, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(priced.costUsd).toBeUndefined();
    expect(priced.costBasis).toBe("unknown");
    expect(priced.model).toBe("acme-free");
    expect(priced.perModel.find((m) => m.model === "acme-free")?.costUsd).toBeNull();
    expect(priced.perModel.find((m) => m.model === "acme-coder-large")?.costUsd).toBeGreaterThan(0);
  });

  it("is unknown with nothing measured", () => {
    expect(priceAtCatalog(gatewayPriceCatalog(gateway), {})).toEqual({
      costUsd: undefined,
      costBasis: "unknown",
      model: undefined,
      perModel: [],
    });
  });
});

describe("priceRun", () => {
  it("keeps the reported figure when the run went to a vendor (no gateway)", async () => {
    const priced = await priceRun({ scope: { workspaceId: WS_ID }, result });
    expect(priced).toEqual({
      costUsd: 0.42,
      costBasis: "reported",
      model: "acme-coder-large",
      perModel: [],
    });
    // No pick: the workspace has no default gateway, so the vendor took it.
    expect(mockDefaultGateway).toHaveBeenCalledWith(WS_ID);
    expect(mockProviderRow).not.toHaveBeenCalled();
  });

  it("is unknown when a vendor run reported no cost", async () => {
    const priced = await priceRun({
      scope: { workspaceId: WS_ID },
      result: { ...result, costUsd: undefined, costBasis: undefined },
    });
    expect(priced.costUsd).toBeUndefined();
    expect(priced.costBasis).toBe("unknown");
  });

  it("prices a run through the picked gateway from its catalog, not Claude Code's guess", async () => {
    mockProviderRow.mockResolvedValue(gateway);
    const priced = await priceRun({
      scope: { workspaceId: WS_ID, agentOptions: { [MODEL_PROVIDER_OPTION_KEY]: GATEWAY_ID } },
      result,
    });
    expect(mockProviderRow).toHaveBeenCalledWith(GATEWAY_ID);
    expect(priced.costBasis).toBe("estimated");
    expect(priced.costUsd).toBeCloseTo(ESTIMATED, 9);
    expect(priced.model).toBe("acme-coder-large");
    expect(priced.gatewayId).toBe(GATEWAY_ID);
  });

  it("takes an explicit provider id over the agent options", async () => {
    mockProviderRow.mockResolvedValue(gateway);
    await priceRun({
      scope: {
        workspaceId: WS_ID,
        providerId: GATEWAY_ID,
        agentOptions: { [MODEL_PROVIDER_OPTION_KEY]: "other" },
      },
      result,
    });
    expect(mockProviderRow).toHaveBeenCalledWith(GATEWAY_ID);
  });

  it("leaves a Bedrock run as reported", async () => {
    mockProviderRow.mockResolvedValue(bedrock);
    const priced = await priceRun({
      scope: { workspaceId: WS_ID, providerId: "b1" },
      result,
    });
    expect(priced.costBasis).toBe("reported");
    expect(priced.costUsd).toBe(0.42);
  });

  it("prices unpicked work the default gateway took from its catalog, with model access unset", async () => {
    mockDefaultGateway.mockResolvedValue({ ...gateway, agents: ["claude-code", "opencode"] });
    const priced = await priceRun({
      scope: { workspaceId: WS_ID, agentType: "claude-code" },
      result,
    });
    expect(mockDefaultGateway).toHaveBeenCalledWith(WS_ID);
    expect(priced.costBasis).toBe("estimated");
    expect(priced.costUsd).toBeCloseTo(ESTIMATED, 9);
    expect(priced.gatewayId).toBe(GATEWAY_ID);
  });

  it("prices it the same way with OPTIO_MODEL_ACCESS=gateway", async () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    mockDefaultGateway.mockResolvedValue({ ...gateway, agents: ["claude-code"] });
    const priced = await priceRun({
      scope: { workspaceId: WS_ID, agentType: "claude-code" },
      result,
    });
    expect(priced.costBasis).toBe("estimated");
    expect(priced.gatewayId).toBe(GATEWAY_ID);
  });

  it("leaves unpicked work as reported with no default gateway (upstream's case)", async () => {
    const priced = await priceRun({ scope: { workspaceId: WS_ID }, result });
    expect(priced.costBasis).toBe("reported");
    expect(priced.costUsd).toBe(0.42);
    expect(priced.gatewayId).toBeUndefined();
  });

  it("leaves it as reported when the default gateway doesn't serve the run's agent", async () => {
    mockDefaultGateway.mockResolvedValue({ ...gateway, agents: ["opencode"] });
    const priced = await priceRun({
      scope: { workspaceId: WS_ID, agentType: "claude-code" },
      result,
    });
    expect(priced.costBasis).toBe("reported");
  });

  it("prices the totals under the reported model when the agent gave no per-model split", async () => {
    mockProviderRow.mockResolvedValue(gateway);
    const priced = await priceRun({
      scope: { workspaceId: WS_ID, providerId: GATEWAY_ID },
      result: { ...result, modelUsage: undefined },
    });
    // inputTokens counts the cache tokens: 1330 - 1000 - 200 = 130 uncached.
    // 130*3 + 60*15 + 1000*0.3 + 200*3.75 = 2340 / 1e6
    expect(priced.costUsd).toBeCloseTo(0.00234, 9);
    expect(priced.costBasis).toBe("estimated");
    expect(priced.model).toBe("acme-coder-large");
    expect(priced.perModel[0]?.tokens).toEqual({
      inputTokens: 130,
      outputTokens: 60,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
    });
  });

  it("is unknown for a gateway run with nothing measured, keeping the model", async () => {
    mockProviderRow.mockResolvedValue(gateway);
    const priced = await priceRun({
      scope: { workspaceId: WS_ID, providerId: GATEWAY_ID },
      result: { costUsd: 0.1, model: "acme-coder-large[1m]" },
    });
    expect(priced).toEqual({
      costUsd: undefined,
      costBasis: "unknown",
      model: "acme-coder-large",
      perModel: [],
      gatewayId: GATEWAY_ID,
    });
  });

  it("is unknown when the catalog prices none of the models the run called", async () => {
    mockProviderRow.mockResolvedValue(gateway);
    const priced = await priceRun({
      scope: { workspaceId: WS_ID, providerId: GATEWAY_ID },
      result: {
        ...result,
        modelUsage: {
          "acme-free": { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
    });
    expect(priced.costUsd).toBeUndefined();
    expect(priced.costBasis).toBe("unknown");
    expect(priced.model).toBe("acme-free");
  });

  it("finds a Job run's gateway through its work definition", async () => {
    mockRows.mockResolvedValue([
      { workspaceId: WS_ID, agentOptions: { [MODEL_PROVIDER_OPTION_KEY]: GATEWAY_ID } },
    ]);
    mockProviderRow.mockResolvedValue(gateway);
    const priced = await priceRun({ scope: { workflowRunId: "wr1" }, result });
    expect(mockProviderRow).toHaveBeenCalledWith(GATEWAY_ID);
    expect(priced.costBasis).toBe("estimated");
  });

  it("finds a review's gateway through its workspace's default", async () => {
    mockRows.mockResolvedValue([{ workspaceId: WS_ID }]);
    mockDefaultGateway.mockResolvedValue(gateway);
    const priced = await priceRun({ scope: { prReviewId: "r1" }, result });
    expect(mockDefaultGateway).toHaveBeenCalledWith(WS_ID);
    expect(priced.costBasis).toBe("estimated");
  });

  it("keeps a review's vendor price when the default gateway does not serve its runtime", async () => {
    mockRows.mockResolvedValue([{ workspaceId: WS_ID }]);
    mockDefaultGateway.mockResolvedValue({ ...gateway, agents: ["claude-code", "opencode"] });
    const priced = await priceRun({ scope: { prReviewId: "r1", agentType: "codex" }, result });
    expect(priced.costBasis).toBe("reported");
    expect(priced.costUsd).toBe(result.costUsd);
  });

  it("records the reported figure (and says why) when the lookup fails", async () => {
    mockProviderRow.mockRejectedValue(new Error("db down"));
    const priced = await priceRun({
      scope: { workspaceId: WS_ID, providerId: GATEWAY_ID },
      result,
    });
    expect(priced.costBasis).toBe("reported");
    expect(priced.costUsd).toBe(0.42);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });
});

describe("pricedUsage", () => {
  it("hands the workers the result with the priced cost, basis and model", async () => {
    mockProviderRow.mockResolvedValue(gateway);
    const usage = await pricedUsage({ workspaceId: WS_ID, providerId: GATEWAY_ID }, result);
    expect(usage).toMatchObject({
      success: true,
      summary: "done",
      costBasis: "estimated",
      model: "acme-coder-large",
      inputTokens: 1330,
      outputTokens: 60,
      cacheReadTokens: 1000,
      cacheWriteTokens: 200,
    });
    expect(usage.costUsd).toBeCloseTo(ESTIMATED, 9);
  });

  it("leaves the cost and basis out when unknown, so the row's columns stay as they were", async () => {
    mockProviderRow.mockResolvedValue(gateway);
    const usage = await pricedUsage(
      { workspaceId: WS_ID, providerId: GATEWAY_ID },
      {
        ...result,
        modelUsage: {
          "acme-free": { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
    );
    expect(usage.costUsd).toBeUndefined();
    expect("costBasis" in usage).toBe(false);
    expect(usage.model).toBe("acme-free");
  });

  it("passes a vendor run through as reported", async () => {
    const usage = await pricedUsage({ workspaceId: WS_ID }, result);
    expect(usage).toMatchObject({
      costUsd: 0.42,
      costBasis: "reported",
      model: "acme-coder-large",
    });
  });
});

describe("gatewayPriceCatalog / withPriceCatalog", () => {
  it("lists one agent's models, or every agent's once, with only ids and prices", () => {
    expect(gatewayPriceCatalog(gateway, "opencode")).toEqual([
      { id: "acme-coder-large", prices: large },
      { id: "acme-gpt", prices: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 } },
    ]);
    expect(gatewayPriceCatalog(gateway).map((m) => m.id)).toEqual([
      "acme-coder-large",
      "acme-haiku",
      "acme-free",
      "acme-gpt",
    ]);
    expect(gatewayPriceCatalog(gateway, "codex")).toEqual([]);
    expect(gatewayPriceCatalog(bedrock)).toEqual([]);
  });

  it("adds the catalog to a machine's launch for a gateway and leaves Bedrock's alone", () => {
    const launch = { id: GATEWAY_ID, kind: "gateway", baseUrl: "https://g" };
    expect(withPriceCatalog(launch, gateway, "claude-code")).toEqual({
      ...launch,
      models: gatewayPriceCatalog(gateway, "claude-code"),
    });
    const aws = { id: "b1", kind: "bedrock", region: "us-west-2" };
    expect(withPriceCatalog(aws, bedrock, "claude-code")).toBe(aws);
  });
});
