import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { modelGatewayCapabilities } from "@optio/shared";

// Settings → Model gateway per gateway type (docs/model-gateway.md "Gateway
// types"): the type picker, and only what the type supports offered.

vi.mock("@/lib/api-client", () => ({ api: {} }));
vi.mock("@/hooks/use-gateway", () => ({
  useGatewayStore: { getState: () => ({ reload: async () => {} }) },
}));

import { GatewayTypeField, syncHint, typeChangePatch } from "./gateway-editor";

afterEach(() => cleanup());

describe("the gateway type picker", () => {
  it("lists all four types, and fills a hosted type's URL into an empty field", () => {
    const onChange = vi.fn();
    render(<GatewayTypeField value="litellm" baseUrl="" authHeader="bearer" onChange={onChange} />);
    const select = screen.getByTestId("gateway-type") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "LiteLLM",
      "OpenAI- / Anthropic-compatible",
      "OpenRouter",
      "Portkey",
    ]);
    fireEvent.change(select, { target: { value: "openrouter" } });
    expect(onChange).toHaveBeenLastCalledWith({
      gatewayType: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      syncUrl: "",
    });
  });

  it("keeps a URL you typed, and resets an auth header the new type doesn't take", () => {
    const onChange = vi.fn();
    render(
      <GatewayTypeField
        value="litellm"
        baseUrl="https://proxy.example.com"
        authHeader="api-key"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("gateway-type"), { target: { value: "portkey" } });
    expect(onChange).toHaveBeenLastCalledWith({
      gatewayType: "portkey",
      authHeader: "bearer",
      syncUrl: "",
    });
  });

  it("swaps one hosted URL for the other, but leaves LiteLLM's sync URL alone", () => {
    const onChange = vi.fn();
    render(
      <GatewayTypeField
        value="openrouter"
        baseUrl="https://openrouter.ai/api"
        authHeader="bearer"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("gateway-type"), { target: { value: "portkey" } });
    expect(onChange).toHaveBeenLastCalledWith({
      gatewayType: "portkey",
      baseUrl: "https://api.portkey.ai",
      syncUrl: "",
    });
    fireEvent.change(screen.getByTestId("gateway-type"), { target: { value: "litellm" } });
    expect(onChange).toHaveBeenLastCalledWith({ gatewayType: "litellm", baseUrl: "" });
    expect(typeChangePatch("generic", "api-key")).toEqual({ syncUrl: "" });
  });
});

describe("what Sync says it does, per type", () => {
  it("adds models on LiteLLM and a generic gateway, and only details OpenRouter's listed ones", () => {
    expect(syncHint(modelGatewayCapabilities("litellm"))).toMatch(/models and limits/);
    expect(syncHint(modelGatewayCapabilities("generic"))).toMatch(/model ids/);
    expect(syncHint(modelGatewayCapabilities("portkey"))).toMatch(/model ids/);
    expect(syncHint(modelGatewayCapabilities("openrouter"))).toMatch(
      /limits and prices of the models you add below.*adds none/,
    );
  });
});
