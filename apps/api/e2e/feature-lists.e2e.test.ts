import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startApiServer, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let api: ApiServerHandle;
let client: Client;
beforeAll(async () => {
  api = await startApiServer({
    env: {
      OPTIO_RUNTIMES: "claude-code,opencode",
      OPTIO_GIT_PLATFORMS: "gitlab",
    },
  });
  client = new Client({ name: "features-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api.baseUrl}/api/mcp`)));
}, 150_000);
afterAll(async () => {
  await client?.close();
  await api?.stop();
});

describe("feature lists through the API", () => {
  it("exposes the selected lists with independent upstream defaults", async () => {
    const res = await fetch(`${api.baseUrl}/api/features`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runtimes: ["claude-code", "opencode"],
      gitPlatforms: ["gitlab"],
      modelAccess: "any",
      agentPolicyDefaults: false,
    });
  });

  it("hides the excluded runtime's options", async () => {
    expect((await fetch(`${api.baseUrl}/api/agent-options/codex`)).status).toBe(404);
  });

  it("narrows controller model catalogs to the selected runtimes", async () => {
    const { tools } = await client.listTools();
    const models = tools.find((tool) => tool.name === "optio_get_models");
    expect(models).toBeDefined();
    expect(models!.inputSchema.properties?.provider).toMatchObject({
      enum: ["anthropic", "opencode"],
    });
  });

  it("requires authentication when sign-in is enabled", async () => {
    await client.close();
    await api.stop();
    api = await startApiServer({ env: { OPTIO_AUTH_DISABLED: "false" } });
    expect((await fetch(`${api.baseUrl}/api/features`)).status).toBe(401);
  });
});
