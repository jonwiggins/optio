import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for repo-pool-service pure functions and pod lifecycle logic:
 * - resolveImage: selects the right container image based on config
 */

// Mock all dependencies
vi.mock("../db/client.js", () => {
  const mockReturning = vi.fn().mockResolvedValue([{ id: "pod-1", repoUrl: "test" }]);
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

  const mockSetWhere = vi.fn().mockResolvedValue(undefined);
  const mockSet = vi.fn().mockReturnValue({ where: mockSetWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  return {
    db: {
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      delete: mockDelete,
    },
  };
});

vi.mock("../db/schema.js", () => ({
  repoPods: {
    id: "id",
    repoUrl: "repoUrl",
    state: "state",
    activeTaskCount: "activeTaskCount",
    updatedAt: "updatedAt",
    lastTaskAt: "lastTaskAt",
    errorMessage: "errorMessage",
    podName: "podName",
    podId: "podId",
    repoBranch: "repoBranch",
  },
}));

vi.mock("./container-service.js", () => ({
  getRuntime: vi.fn().mockReturnValue({
    create: vi.fn().mockResolvedValue({ id: "pod-123", name: "optio-repo-abc" }),
    status: vi.fn().mockResolvedValue({ state: "running" }),
    destroy: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({
      stdout: { [Symbol.asyncIterator]: () => ({ next: () => ({ done: true }) }) },
    }),
  }),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { resolveImage } from "./repo-pool-service.js";

describe("resolveImage", () => {
  const originalEnv = process.env.OPTIO_AGENT_IMAGE;

  beforeEach(() => {
    delete process.env.OPTIO_AGENT_IMAGE;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.OPTIO_AGENT_IMAGE = originalEnv;
    }
  });

  it("returns custom image when provided", () => {
    const image = resolveImage({ customImage: "my-org/custom-agent:v2" });
    expect(image).toBe("my-org/custom-agent:v2");
  });

  it("returns preset image for known preset", () => {
    const image = resolveImage({ preset: "node" });
    expect(image).toContain("node");
  });

  it("returns preset image for python preset", () => {
    const image = resolveImage({ preset: "python" });
    expect(image).toContain("python");
  });

  it("returns preset image for rust preset", () => {
    const image = resolveImage({ preset: "rust" });
    expect(image).toContain("rust");
  });

  it("returns preset image for go preset", () => {
    const image = resolveImage({ preset: "go" });
    expect(image).toContain("go");
  });

  it("returns preset image for full preset", () => {
    const image = resolveImage({ preset: "full" });
    expect(image).toContain("full");
  });

  it("returns default image when no config provided", () => {
    const image = resolveImage();
    expect(image).toBe("optio-agent:latest");
  });

  it("returns OPTIO_AGENT_IMAGE env var when set and no config", () => {
    process.env.OPTIO_AGENT_IMAGE = "registry.example.com/agent:v3";
    const image = resolveImage();
    expect(image).toBe("registry.example.com/agent:v3");
  });

  it("prefers custom image over preset", () => {
    const image = resolveImage({
      customImage: "my-custom:latest",
      preset: "node",
    });
    expect(image).toBe("my-custom:latest");
  });

  it("returns default for empty config object", () => {
    const image = resolveImage({});
    expect(image).toBe("optio-agent:latest");
  });

  it("returns default for unknown preset", () => {
    const image = resolveImage({ preset: "nonexistent" as any });
    expect(image).toBe("optio-agent:latest");
  });
});
