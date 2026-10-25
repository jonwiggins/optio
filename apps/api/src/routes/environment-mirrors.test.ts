import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const readNamespacedConfigMap = vi.fn();

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: class {
    loadFromDefault() {}
    makeApiClient() {
      return { readNamespacedConfigMap: (...a: unknown[]) => readNamespacedConfigMap(...a) };
    }
  },
  CoreV1Api: class {},
}));

vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  environmentMirrorsRoutes,
  detectMirrors,
  mirrorsFrom,
  _resetMirrorsCache,
} from "./environment-mirrors.js";

const ENV_KEYS = [
  "OPTIO_AGENT_ENV_CONFIGMAP",
  "OPTIO_NAMESPACE",
  "NPM_CONFIG_REGISTRY",
  "npm_config_registry",
  "PIP_INDEX_URL",
  "UV_DEFAULT_INDEX",
  "UV_INDEX_URL",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  _resetMirrorsCache();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("mirrorsFrom", () => {
  it("reads each tool's own variable", () => {
    expect(mirrorsFrom({})).toEqual({ npm: false, pip: false, uv: false });
    expect(mirrorsFrom({ NPM_CONFIG_REGISTRY: "https://art.example/npm/" })).toEqual({
      npm: true,
      pip: false,
      uv: false,
    });
    expect(mirrorsFrom({ PIP_INDEX_URL: "https://art.example/pypi/simple" })).toMatchObject({
      pip: true,
      uv: false,
    });
    expect(mirrorsFrom({ UV_INDEX_URL: "https://art.example/pypi/simple" }).uv).toBe(true);
    expect(mirrorsFrom({ UV_DEFAULT_INDEX: "https://art.example/pypi/simple" }).uv).toBe(true);
    expect(mirrorsFrom({ NPM_CONFIG_REGISTRY: "   " }).npm).toBe(false);
  });

  it("doesn't count the public registries as mirrors", () => {
    expect(mirrorsFrom({ npm_config_registry: "https://registry.npmjs.org/" }).npm).toBe(false);
    expect(mirrorsFrom({ NPM_CONFIG_REGISTRY: "https://registry.npmjs.org" }).npm).toBe(false);
    expect(mirrorsFrom({ PIP_INDEX_URL: "https://pypi.org/simple" }).pip).toBe(false);
    expect(mirrorsFrom({ UV_INDEX_URL: "https://pypi.org/simple/" }).uv).toBe(false);
    expect(
      mirrorsFrom({ npm_config_registry: "https://registry.npmjs.org.art.example/" }).npm,
    ).toBe(true);
  });
});

describe("detectMirrors", () => {
  it("reads the agent-env ConfigMap the API names", async () => {
    process.env.OPTIO_AGENT_ENV_CONFIGMAP = "optio-agent-env";
    process.env.OPTIO_NAMESPACE = "optio";
    readNamespacedConfigMap.mockResolvedValue({
      data: { NPM_CONFIG_REGISTRY: "https://art.example/npm/", GITLAB_HOSTS: "git.example" },
    });

    expect(await detectMirrors()).toEqual({ npm: true, pip: false, uv: false });
    expect(readNamespacedConfigMap).toHaveBeenCalledWith({
      name: "optio-agent-env",
      namespace: "optio",
    });
  });

  it("answers from the API's own environment when there is no ConfigMap to read", async () => {
    process.env.PIP_INDEX_URL = "https://art.example/pypi/simple";
    expect(await detectMirrors()).toEqual({ npm: false, pip: true, uv: false });
    expect(readNamespacedConfigMap).not.toHaveBeenCalled();
  });

  it("falls back to the API's environment when the read fails", async () => {
    process.env.OPTIO_AGENT_ENV_CONFIGMAP = "optio-agent-env";
    process.env.UV_DEFAULT_INDEX = "https://art.example/pypi/simple";
    readNamespacedConfigMap.mockRejectedValue(new Error("forbidden"));
    expect(await detectMirrors()).toEqual({ npm: false, pip: false, uv: true });
  });

  it("caches the answer", async () => {
    process.env.OPTIO_AGENT_ENV_CONFIGMAP = "optio-agent-env";
    readNamespacedConfigMap.mockResolvedValue({ data: {} });
    await detectMirrors();
    await detectMirrors();
    expect(readNamespacedConfigMap).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/environment/mirrors", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildRouteTestApp(environmentMirrorsRoutes);
  });

  it("returns the three booleans", async () => {
    process.env.OPTIO_AGENT_ENV_CONFIGMAP = "optio-agent-env";
    readNamespacedConfigMap.mockResolvedValue({
      data: { NPM_CONFIG_REGISTRY: "https://art.example/npm/", UV_INDEX_URL: "https://x" },
    });

    const res = await app.inject({ method: "GET", url: "/api/environment/mirrors" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ npm: true, pip: false, uv: true });
  });

  it("says no mirrors outside Kubernetes with nothing configured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/environment/mirrors" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ npm: false, pip: false, uv: false });
  });
});
