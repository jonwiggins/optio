import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig, RESPONSE_BODY_LIMIT } from "./bridge.js";
import { createServer } from "./server.js";

const TOKEN = "s3cr3t-token-value-xyz";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let http: Server;
let baseUrl: string;
const seen: Seen[] = [];

beforeAll(async () => {
  http = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/v1/big") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.alloc(3 * 1024 * 1024, 0x61));
        return;
      }
      if (url.pathname === "/v1/missing") {
        res.writeHead(404, "Not Found", { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
        return;
      }
      if (url.pathname === "/v1/echo-auth") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

async function connect(env: Record<string, string | undefined> = {}) {
  const cfg = parseConfig({
    OPTIO_HTTP_NAME: "testapi",
    OPTIO_HTTP_DESCRIPTION: "A test API",
    OPTIO_HTTP_BASE_URL: baseUrl,
    OPTIO_HTTP_AUTH_VALUE: `Bearer ${TOKEN}`,
    OPTIO_HTTP_EXTRA_HEADERS: '{"Accept":"application/json","X-Static":"yes"}',
    ...env,
  });
  const server = createServer(cfg);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

describe("mcp-bridge server", () => {
  it("lists describe and request, and describe never leaks the token", async () => {
    const { client, close } = await connect();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["describe", "request"]);
      const describeText = textOf(await client.callTool({ name: "describe", arguments: {} }));
      expect(describeText).toContain("name: testapi");
      expect(describeText).toContain("A test API");
      expect(describeText).toContain(baseUrl);
      expect(describeText).toContain("auth header: Authorization");
      expect(describeText).toContain("Accept, X-Static");
      expect(describeText).not.toContain(TOKEN);
      expect(JSON.stringify(tools)).not.toContain(TOKEN);
    } finally {
      await close();
    }
  });

  it("proxies a request with the auth and static headers, and the output never contains the token", async () => {
    const { client, close } = await connect();
    try {
      seen.length = 0;
      const result = await client.callTool({
        name: "request",
        arguments: {
          method: "POST",
          path: "/items",
          query: { page: 2, dry: true },
          headers: { Authorization: "Bearer forged", "X-Static": "no", "X-Mine": "1" },
          body: { name: "thing" },
        },
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text.startsWith("HTTP 200 OK\napplication/json; charset=utf-8\n\n")).toBe(true);
      expect(text).toContain('"ok": true');
      expect(text).toContain('"page": "2"');
      expect(text).toContain('"dry": "true"');
      expect(text).not.toContain(TOKEN);

      expect(seen).toHaveLength(1);
      const req = seen[0]!;
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/items?page=2&dry=true");
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(req.headers.accept).toBe("application/json");
      expect(req.headers["x-static"]).toBe("yes");
      expect(req.headers["x-mine"]).toBe("1");
      expect(req.headers["content-type"]).toBe("application/json");
      expect(req.body).toBe('{"name":"thing"}');
    } finally {
      await close();
    }
  });

  it("redacts the token even when the API echoes it back", async () => {
    const { client, close } = await connect();
    try {
      const text = textOf(
        await client.callTool({
          name: "request",
          arguments: { method: "GET", path: "/echo-auth" },
        }),
      );
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(TOKEN);
    } finally {
      await close();
    }
  });

  it("returns a non-2xx status as text, not as an error", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "request",
        arguments: { method: "GET", path: "/missing" },
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text.startsWith("HTTP 404 Not Found")).toBe(true);
      expect(text).toContain('"error": "nope"');
    } finally {
      await close();
    }
  });

  it("truncates a 3 MiB body at 2 MiB with a note", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "request",
        arguments: { method: "GET", path: "/big" },
      });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("truncated: true");
      const body = text.split("\n\n")[1] ?? "";
      expect(body.length).toBe(RESPONSE_BODY_LIMIT);
      expect(text.length).toBeLessThan(RESPONSE_BODY_LIMIT + 1024);
    } finally {
      await close();
    }
  });

  it("refuses an escaping path without making a request", async () => {
    const { client, close } = await connect();
    try {
      seen.length = 0;
      for (const path of ["https://evil.example/x", "../../etc", "//evil.example/x"]) {
        const result = await client.callTool({
          name: "request",
          arguments: { method: "GET", path },
        });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("request not sent");
      }
      expect(seen).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("sends no auth header when the config has no auth", async () => {
    const { client, close } = await connect({ OPTIO_HTTP_AUTH_VALUE: "" });
    try {
      seen.length = 0;
      await client.callTool({ name: "request", arguments: { method: "GET", path: "/items" } });
      expect(seen[0]!.headers.authorization).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("reports a connection failure as an error result", async () => {
    const { client, close } = await connect({ OPTIO_HTTP_BASE_URL: "http://127.0.0.1:1/" });
    try {
      const result = await client.callTool({
        name: "request",
        arguments: { method: "GET", path: "/x" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("request failed");
      expect(textOf(result)).not.toContain(TOKEN);
    } finally {
      await close();
    }
  });
});
