import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateController } from "../services/controller-auth.js";
import { createControllerMcp } from "../services/controller-mcp.js";
import { isAuthDisabled } from "../services/oauth/index.js";

/** HTTP MCP uses bearer credentials only. No cookie auth or ambient browser
 * sessions. Origin validation also protects auth-disabled local deployments.
 */
function controllerOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (process.env.PUBLIC_URL && parsed.origin === new URL(process.env.PUBLIC_URL).origin)
      return true;
    return (
      isAuthDisabled() &&
      ["http:", "https:"].includes(parsed.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export async function controllerMcpRoutes(app: FastifyInstance) {
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/api/mcp",
    bodyLimit: 256 * 1024,
    schema: { hide: true },
    handler: async (req, reply) => {
      if (!controllerOriginAllowed(req.headers.origin))
        return reply.code(403).send({ error: "Origin not allowed" });
      // Without credentials, a local listener must not accept a DNS name
      // controlled by a website that rebinds its DNS to the user's machine.
      if (isAuthDisabled() && !req.headers.authorization) {
        let hostname: string;
        try {
          hostname = new URL(`http://${req.headers.host}`).hostname;
        } catch {
          return reply.code(403).send({ error: "Host not allowed" });
        }
        if (hostname !== "localhost" && hostname !== "[::1]" && !isIP(hostname))
          return reply.code(403).send({ error: "Host not allowed" });
      }
      const principal = await authenticateController(
        req.headers.authorization,
        req.headers["x-workspace-id"] as string | undefined,
      );
      if (!principal)
        return reply
          .code(401)
          .header("WWW-Authenticate", 'Bearer realm="Optio MCP"')
          .send({ error: "A valid Optio API key or active run credential is required" });
      if (req.method !== "POST")
        return reply
          .code(405)
          .header("Allow", "POST")
          .send({ error: "This MCP endpoint is stateless; use POST" });
      const server = createControllerMcp(
        principal,
        async () =>
          !!(await authenticateController(
            req.headers.authorization,
            req.headers["x-workspace-id"] as string | undefined,
          )),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        const headers = new Headers();
        for (const name of ["accept", "content-type", "mcp-protocol-version"]) {
          const value = req.headers[name];
          if (typeof value === "string") headers.set(name, value);
        }
        const response = await transport.handleRequest(
          new Request("http://optio/api/mcp", { method: "POST", headers }),
          { parsedBody: req.body },
        );
        const body = await response.text();
        reply.code(response.status);
        response.headers.forEach((value, name) => reply.header(name, value));
        return reply.send(body);
      } finally {
        await server.close();
      }
    },
  });
}
