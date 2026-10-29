import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const listConnectionProviders = vi.fn();
const createConnection = vi.fn();
const testConnection = vi.fn();
const createSecret = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    listConnectionProviders: (...a: unknown[]) => listConnectionProviders(...a),
    createConnection: (...a: unknown[]) => createConnection(...a),
    testConnection: (...a: unknown[]) => testConnection(...a),
    createSecret: (...a: unknown[]) => createSecret(...a),
    listRepos: () => Promise.resolve({ repos: [] }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    user: { id: "u1", displayName: "Jon Wiggins" },
    userId: "u1",
    isAdmin: false,
    loaded: true,
    authDisabled: false,
    isDeploymentAdmin: false,
  }),
}));

// The deployment's feature lists (default: everything); tests pick the restricted deployment's.
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, loaded: true }),
}));

import { ConnectGallery, galleryOffers, serviceProviders } from "./connect-gallery";

const provider = (slug: string, extra: Record<string, unknown> = {}) => ({
  id: `p-${slug}`,
  slug,
  name: slug[0].toUpperCase() + slug.slice(1),
  description: `${slug} service`,
  icon: slug,
  category: "productivity",
  type: "mcp",
  builtIn: true,
  parts: ["credentials"],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

const PROVIDERS = [
  provider("custom-mcp"),
  provider("slack"),
  provider("github-enhanced", { name: "GitHub (enhanced)" }),
  provider("pylon", {
    configSchema: {
      properties: {
        apiToken: { type: "string", title: "API token", format: "secret" },
        region: {
          type: "string",
          title: "Region",
          enum: ["us", "eu"],
          enumTitles: ["US", "EU"],
          default: "us",
        },
      },
      required: ["apiToken"],
    },
    note: "Use the pylon tools.",
  }),
  provider("custom-http"),
];

beforeEach(() => {
  listConnectionProviders.mockReset().mockResolvedValue({ providers: PROVIDERS });
  createConnection.mockReset();
  testConnection.mockReset();
  createSecret.mockReset();
});
afterEach(() => {
  cleanup();
  features = featuresFromEnv({});
});

describe("serviceProviders by the connection providers on offer", () => {
  it("preserves the existing service order and can exclude a GitLab provider", () => {
    const withGitLab = [...PROVIDERS, provider("gitlab", { name: "GitLab" })];
    expect(serviceProviders(withGitLab as never, featuresFromEnv({})).map((p) => p.slug)).toEqual([
      "github-enhanced",
      "slack",
      "pylon",
      "gitlab",
    ]);
    expect(galleryOffers("gitlab", featuresFromEnv({}))).toBe(true);
    expect(
      galleryOffers(
        "gitlab",
        featuresFromEnv({ OPTIO_CONNECTION_PROVIDERS: "github,slack,pylon" }),
      ),
    ).toBe(false);
  });
});

describe("ConnectGallery under the restricted deployment", () => {
  const STANDARD_CATALOG = [
    ...PROVIDERS,
    provider("postgres"),
    provider("filesystem"),
    provider("aws"),
    provider("custom-http"),
    provider("forge", { builtIn: false }),
  ];

  it("offers the restricted deployment's providers and a workspace's own, nothing cloud-only", () => {
    expect(
      serviceProviders(
        STANDARD_CATALOG as never,
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ).map((p) => p.slug),
    ).toEqual(["postgres", "filesystem", "forge"]);
    expect(
      galleryOffers(
        "github-enhanced",
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ),
    ).toBe(false);
    expect(
      galleryOffers(
        "custom-mcp",
        featuresFromEnv({
          OPTIO_RUNTIMES: "claude-code,opencode",
          OPTIO_GIT_PLATFORMS: "gitlab",
          OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
          OPTIO_TICKET_SOURCES: "gitlab,jira",
          OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
        }),
      ),
    ).toBe(true);
    // The default deployment keeps every tile.
    expect(galleryOffers("github-enhanced", featuresFromEnv({}))).toBe(true);
    expect(
      serviceProviders(STANDARD_CATALOG as never, featuresFromEnv({})).map((p) => p.slug),
    ).toContain("pylon");
  });

  it("renders no GitHub, Slack or Pylon tile", async () => {
    features = featuresFromEnv({
      OPTIO_RUNTIMES: "claude-code,opencode",
      OPTIO_GIT_PLATFORMS: "gitlab",
      OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
      OPTIO_TICKET_SOURCES: "gitlab,jira",
      OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
    });
    listConnectionProviders.mockResolvedValue({ providers: STANDARD_CATALOG });
    render(<ConnectGallery open onClose={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByTestId("connect-tile-postgres");
    expect(screen.queryByTestId("connect-tile-github-enhanced")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connect-tile-slack")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connect-tile-pylon")).not.toBeInTheDocument();
    expect(screen.getByTestId("connect-tile-secret")).toBeInTheDocument();
  });

  it("won't open straight on a provider the restricted deployment doesn't offer", async () => {
    features = featuresFromEnv({
      OPTIO_RUNTIMES: "claude-code,opencode",
      OPTIO_GIT_PLATFORMS: "gitlab",
      OPTIO_TRIGGERS: "manual,schedule,webhook,ticket,gitlab,jira,sentry,alertmanager",
      OPTIO_TICKET_SOURCES: "gitlab,jira",
      OPTIO_CONNECTION_PROVIDERS: "postgres,filesystem,custom-http,custom-mcp",
    });
    render(<ConnectGallery open onClose={vi.fn()} onCreated={vi.fn()} initialProvider="pylon" />);
    await waitFor(() => expect(listConnectionProviders).toHaveBeenCalled());
    expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
  });
});
