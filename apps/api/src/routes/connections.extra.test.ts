import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockListProviders = vi.fn();
const mockGetProvider = vi.fn();
const mockGetProviderBySlug = vi.fn();
const mockCreateProvider = vi.fn();
const mockListConnections = vi.fn();
const mockGetConnection = vi.fn();
const mockCreateConnection = vi.fn();
const mockUpdateConnection = vi.fn();
const mockDeleteConnection = vi.fn();
const mockTestConnection = vi.fn();
const mockListAssignments = vi.fn();
const mockGetAssignment = vi.fn();
const mockCreateAssignment = vi.fn();
const mockUpdateAssignment = vi.fn();
const mockDeleteAssignment = vi.fn();
const mockGetConnectionsForTask = vi.fn();
const mockListConnectionsForRepo = vi.fn();

vi.mock("../services/connection-service.js", () => ({
  listProviders: (...args: unknown[]) => mockListProviders(...args),
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
  getProviderBySlug: (...args: unknown[]) => mockGetProviderBySlug(...args),
  createProvider: (...args: unknown[]) => mockCreateProvider(...args),
  listConnections: (...args: unknown[]) => mockListConnections(...args),
  getConnection: (...args: unknown[]) => mockGetConnection(...args),
  createConnection: (...args: unknown[]) => mockCreateConnection(...args),
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
  deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
  listAssignments: (...args: unknown[]) => mockListAssignments(...args),
  getAssignment: (...args: unknown[]) => mockGetAssignment(...args),
  createAssignment: (...args: unknown[]) => mockCreateAssignment(...args),
  updateAssignment: (...args: unknown[]) => mockUpdateAssignment(...args),
  deleteAssignment: (...args: unknown[]) => mockDeleteAssignment(...args),
  getConnectionsForTask: (...args: unknown[]) => mockGetConnectionsForTask(...args),
  listConnectionsForRepo: (...args: unknown[]) => mockListConnectionsForRepo(...args),
}));

const mockGetRepo = vi.fn();
vi.mock("../services/repo-service.js", () => ({
  getRepo: (...args: unknown[]) => mockGetRepo(...args),
}));

const mockConnectionCatalog = vi.fn();
vi.mock("../services/connection-catalog-service.js", () => ({
  connectionCatalog: (...args: unknown[]) => mockConnectionCatalog(...args),
}));

import { connectionRoutes } from "./connections.js";
import { FeatureUnavailableError } from "../services/feature-guard.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(connectionRoutes);
}

describe("connections with OPTIO_CONNECTION_PROVIDERS narrowed", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("OPTIO_CONNECTION_PROVIDERS", "postgres,filesystem,custom-http,custom-mcp");
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const entry = (id: string, providerSlug: string | null, kind = "connection") => ({
    kind,
    id,
    name: id,
    scope: "workspace",
    default: false,
    enabled: true,
    parts: ["tools"],
    providerSlug,
  });

  it("leaves connections of providers outside the list out of the catalog", async () => {
    mockConnectionCatalog.mockResolvedValue([
      entry("notion-1", "notion"),
      entry("pg-1", "postgres"),
      entry("secret-1", null, "secret"),
    ]);
    const res = await app.inject({ method: "GET", url: "/api/connections/catalog" });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries.map((e: { id: string }) => e.id)).toEqual(["pg-1", "secret-1"]);

    vi.stubEnv("OPTIO_CONNECTION_PROVIDERS", "");
    const full = await app.inject({ method: "GET", url: "/api/connections/catalog" });
    expect(full.json().entries).toHaveLength(3);
  });

  it("answers 400 when the provider isn't available, 404 for its slug", async () => {
    mockCreateConnection.mockRejectedValue(
      new FeatureUnavailableError("connectionProviders", "notion"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { name: "My Notion", providerSlug: "notion" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("notion isn't available in this deployment");

    mockGetProviderBySlug.mockResolvedValue({ id: "p1", slug: "notion", builtIn: true });
    const slug = await app.inject({ method: "GET", url: "/api/connection-providers/notion" });
    expect(slug.statusCode).toBe(404);
  });
});
