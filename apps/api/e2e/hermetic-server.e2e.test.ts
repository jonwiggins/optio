/**
 * E2E: the API servers the test tiers start (this tier and the web e2e stack,
 * both via startApiServer) are hermetic. They run next to the developer's
 * real Optio, so they must never reach its cluster or its Claude login:
 * cluster routes are served by a fake read-only Kubernetes API, and the
 * host's Keychain / ~/.claude credentials are invisible
 * (src/test-utils/e2e/hermetic-env.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;

beforeAll(async () => {
  server = await startApiServer();
}, 150_000);

afterAll(async () => {
  await server?.stop();
});

async function get(path: string) {
  const res = await fetch(`${server.baseUrl}${path}`);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // text/plain
  }
  return { status: res.status, body };
}

describe("test API servers are isolated from this machine", () => {
  it("serve the cluster pages from the fake read-only Kubernetes API", async () => {
    const { status, body } = await get("/api/cluster/overview");
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.nodes.map((n: { name: string }) => n.name)).toEqual(["test-node"]);
    expect(body.pods.map((p: { name: string }) => p.name)).toContain("optio-api-0");
  });

  it("cannot see this machine's Claude login", async () => {
    const token = await get("/api/auth/claude-token");
    expect(token.status).toBe(503);

    const status = await get("/api/auth/status");
    expect(status.status).toBe(200);
    expect(status.body.subscription.available).toBe(false);
  });
});
