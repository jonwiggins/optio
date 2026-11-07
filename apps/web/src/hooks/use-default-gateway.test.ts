import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ api: {} }));

import type { ModelProvider } from "@optio/shared";
import { defaultGatewayFor } from "./use-default-gateway";

const gw = (id: string, extra: Partial<ModelProvider> = {}): ModelProvider =>
  ({
    id,
    name: id,
    kind: "gateway",
    agents: ["claude-code"],
    ownerUserId: null,
    mine: false,
    models: { "claude-code": [{ id: `${id}-model` }] },
    ...extra,
  }) as unknown as ModelProvider;

describe("defaultGatewayFor", () => {
  it("picks the workspace's default gateway when it serves the runtime", () => {
    const list = [gw("org"), gw("default")];
    expect(defaultGatewayFor("claude-code", list, "default")?.id).toBe("default");
  });

  it("falls back to the organization's first, never someone else's", () => {
    const theirs = gw("theirs", { ownerUserId: "u2", mine: false });
    expect(defaultGatewayFor("claude-code", [theirs, gw("org")], null)?.id).toBe("org");
    expect(defaultGatewayFor("claude-code", [theirs], null)).toBeNull();
  });

  it("finds none for a runtime no gateway serves, or a terminal", () => {
    expect(defaultGatewayFor("opencode", [gw("org")], "org")).toBeNull();
    expect(defaultGatewayFor("", [gw("org")], "org")).toBeNull();
  });
});
