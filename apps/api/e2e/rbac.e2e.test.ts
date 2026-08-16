/**
 * E2E: workspace RBAC enforcement through the real API server with auth ENABLED.
 *
 * Unlike the other e2e suites (which run with OPTIO_AUTH_DISABLED=true), this
 * boots the server with real authentication and drives it with three seeded
 * principals — admin, member, viewer — sharing one workspace. Verifies:
 *   - unauthenticated requests are rejected,
 *   - viewers are read-only (default-deny baseline in the auth plugin),
 *   - viewers keep self-scoped mutations (workspace switch),
 *   - member-level operational routes work but admin-only config routes 403,
 *   - admins pass the admin gates (secrets, claude-token proxy).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;

const WS_ID = randomUUID();
const TOKENS = { admin: "", member: "", viewer: "" };

async function seedPrincipals(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql`INSERT INTO workspaces (id, name, slug) VALUES (${WS_ID}, 'RBAC e2e', ${`rbac-e2e-${WS_ID.slice(0, 8)}`})`;
    for (const role of ["admin", "member", "viewer"] as const) {
      const userId = randomUUID();
      const token = `e2e-${role}-${randomBytes(16).toString("hex")}`;
      TOKENS[role] = token;
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await sql`
        INSERT INTO users (id, provider, external_id, email, display_name, default_workspace_id)
        VALUES (${userId}, 'github', ${`rbac-${role}`}, ${`${role}@rbac.e2e`}, ${`RBAC ${role}`}, ${WS_ID})`;
      await sql`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (${WS_ID}, ${userId}, ${role})`;
      await sql`
        INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${userId}, ${tokenHash}, NOW() + INTERVAL '1 day')`;
    }
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await seedPrincipals();
  server = await startApiServer({ env: { OPTIO_AUTH_DISABLED: "false" } });
}, 150_000);

afterAll(async () => {
  await server?.stop();
});

async function call(
  role: "admin" | "member" | "viewer" | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(role ? { authorization: `Bearer ${TOKENS[role]}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    // some endpoints (claude-token) reply text/plain
  }
  return { status: res.status, body: parsed };
}

describe("RBAC e2e (auth enabled)", () => {
  it("rejects unauthenticated requests", async () => {
    const { status } = await call(null, "GET", "/api/tasks");
    expect(status).toBe(401);
  });

  it("lets a viewer read but not mutate", async () => {
    const read = await call("viewer", "GET", "/api/tasks");
    expect(read.status).toBe(200);

    const create = await call("viewer", "POST", "/api/jobs", {
      name: "viewer job",
      promptTemplate: "nope",
      agentRuntime: "claude-code",
    });
    expect(create.status).toBe(403);
    expect(create.body.error).toMatch(/read-only/);

    // Route without an explicit preHandler — proves the plugin baseline holds.
    const template = await call("viewer", "POST", "/api/prompt-templates", {
      name: "viewer template",
      template: "hi",
    });
    expect(template.status).toBe(403);
  });

  it("keeps self-scoped mutations open to viewers", async () => {
    const { status } = await call("viewer", "POST", `/api/workspaces/${WS_ID}/switch`, {});
    expect(status).toBe(200);
  });

  it("returns 403 (not 500) when switching to a non-member workspace", async () => {
    const { status } = await call("viewer", "POST", `/api/workspaces/${randomUUID()}/switch`, {});
    expect(status).toBe(403);
  });

  it("lets a member run operational routes but not admin config", async () => {
    const job = await call("member", "POST", "/api/jobs", {
      name: "member job",
      promptTemplate: "Say hello",
      agentRuntime: "claude-code",
    });
    expect(job.status).toBe(201);

    const secret = await call("member", "POST", "/api/secrets", {
      name: "SHOULD_NOT_WORK",
      value: "x",
    });
    expect(secret.status).toBe(403);

    const settings = await call("member", "PUT", "/api/optio/settings", { maxTurns: 5 });
    expect(settings.status).toBe(403);

    const token = await call("member", "GET", "/api/auth/claude-token");
    expect(token.status).toBe(403);
  });

  it("lets an admin through the admin gates", async () => {
    const secret = await call("admin", "POST", "/api/secrets", {
      name: "RBAC_E2E_SECRET",
      value: "shhh",
    });
    expect([200, 201]).toContain(secret.status);

    // No Claude token is configured in this environment: 503 (not 401/403)
    // proves the admin passed the role gate and reached the handler.
    const token = await call("admin", "GET", "/api/auth/claude-token");
    expect([200, 503]).toContain(token.status);
  });

  it("blocks a viewer from admin-only reads that a member can see", async () => {
    const viewerSecrets = await call("viewer", "GET", "/api/secrets");
    expect(viewerSecrets.status).toBe(403);

    const memberSecrets = await call("member", "GET", "/api/secrets");
    expect(memberSecrets.status).toBe(200);
  });
});
