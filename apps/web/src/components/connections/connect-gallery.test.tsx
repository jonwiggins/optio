import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

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

import { ConnectGallery, serviceProviders, defaultConnectionName } from "./connect-gallery";

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
afterEach(() => cleanup());

describe("serviceProviders / defaultConnectionName", () => {
  it("orders the catalog, drops the custom providers, and names the GitHub tile", () => {
    expect(serviceProviders(PROVIDERS as never).map((p) => p.slug)).toEqual([
      "github-enhanced",
      "slack",
      "pylon",
    ]);
    expect(defaultConnectionName({ slug: "aws", name: "AWS" }, "private", "Jon Wiggins")).toBe(
      "Jon's AWS",
    );
    expect(defaultConnectionName({ slug: "aws", name: "AWS" }, "private", "")).toBe("My AWS");
    expect(defaultConnectionName({ slug: "aws", name: "AWS" }, "organization", "Jon")).toBe("AWS");
  });
});

describe("ConnectGallery", () => {
  it("shows service tiles from the catalog plus the Something-else tiles", async () => {
    render(<ConnectGallery open onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByTestId("connect-gallery")).toBeInTheDocument();
    await screen.findByTestId("connect-tile-pylon");
    expect(screen.getByTestId("connect-tile-github-enhanced")).toHaveTextContent("GitHub");
    expect(screen.queryByTestId("connect-tile-custom-mcp")).not.toBeInTheDocument();
    expect(screen.getByTestId("connect-tile-secret")).toBeInTheDocument();
    expect(screen.getByTestId("connect-tile-mcp")).toBeInTheDocument();
  });

  it("picking pylon shows its fields and Save posts the connection", async () => {
    const onCreated = vi.fn();
    createConnection.mockResolvedValue({ connection: { id: "c1", name: "Jon's Pylon" } });
    render(<ConnectGallery open onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.click(await screen.findByTestId("connect-tile-pylon"));

    const nameInput = screen.getByLabelText("Connection name") as HTMLInputElement;
    expect(nameInput.value).toBe("Jon's Pylon");
    const region = screen.getByLabelText(/Region/) as HTMLSelectElement;
    expect(region.tagName).toBe("SELECT");
    expect(screen.getByText("What the agent is told")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/API token/), { target: { value: "tok" } });
    fireEvent.change(region, { target: { value: "eu" } });
    fireEvent.click(save);

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createConnection).toHaveBeenCalledWith({
      providerSlug: "pylon",
      name: "Jon's Pylon",
      owner: "me",
      config: { apiToken: "tok", region: "eu" },
      assignments: [{ repoId: null, agentTypes: [] }],
    });
    expect(testConnection).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith({ kind: "connection", id: "c1", name: "Jon's Pylon" });
  });

  it("the Secret tile posts a private secret", async () => {
    const onCreated = vi.fn();
    createSecret.mockResolvedValue({ name: "MY_TOKEN", scope: "user" });
    render(<ConnectGallery open onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.click(await screen.findByTestId("connect-tile-secret"));
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "my-token" } });
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "s3cr3t" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createSecret).toHaveBeenCalledWith({ name: "MY_TOKEN", value: "s3cr3t", scope: "user" });
    expect(onCreated).toHaveBeenCalledWith({ kind: "secret", id: "MY_TOKEN", name: "MY_TOKEN" });
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<ConnectGallery open onClose={onClose} onCreated={vi.fn()} />);
    await screen.findByTestId("connect-tile-pylon");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
