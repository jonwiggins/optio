import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../db/client.js", () => ({ db: {} }));
vi.mock("../../repo-service.js", () => ({}));

import type { RepoManifest } from "@optio/shared";
import { ManifestError } from "../context.js";
import { repoHandler } from "./repo.js";

const manifest = (spec: Record<string, unknown>) =>
  ({
    apiVersion: "optio.dev/v1",
    kind: "Repo",
    metadata: { name: "acme/widgets" },
    spec: { url: "https://gitlab.example.com/acme/widgets", ...spec },
  }) as unknown as RepoManifest;

describe("kind: Repo — imagePreset", () => {
  const saved = process.env.OPTIO_AGENT_PRESETS;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPTIO_AGENT_PRESETS;
    else process.env.OPTIO_AGENT_PRESETS = saved;
  });

  it("refuses a preset this deployment doesn't have, naming it", async () => {
    process.env.OPTIO_AGENT_PRESETS = "base,node";
    const err = await repoHandler
      .desire(manifest({ imagePreset: "dind" }), {} as never)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect(err.message).toBe(
      'Image preset "dind" is not available in this deployment (available: base, node)',
    );
  });

  it("takes one it has", async () => {
    process.env.OPTIO_AGENT_PRESETS = "base,node";
    const d = await repoHandler.desire(manifest({ imagePreset: "node" }), {} as never);
    expect(d.settings.imagePreset).toBe("node");
  });
});

describe("kind: Repo — autoMerge needs the file's confirmation", () => {
  // The deployment asks for the confirmation (off by default).
  beforeEach(() => {
    process.env.OPTIO_MERGE_CONFIRMATION = "true";
  });
  afterEach(() => {
    delete process.env.OPTIO_MERGE_CONFIRMATION;
  });
  it("refuses autoMerge: true without autoMergeConfirmed: true", async () => {
    const err = await repoHandler
      .desire(manifest({ autoMerge: true }), {} as never)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect(err.message).toContain("Automatic merging needs the checkbox and the confirmation");
  });

  it("takes it confirmed, and never stores the confirmation as a setting", async () => {
    const d = await repoHandler.desire(
      manifest({ autoMerge: true, autoMergeConfirmed: true }),
      {} as never,
    );
    expect(d.settings).toEqual({ autoMerge: true });
    expect(d.autoMergeConfirmed).toBe(true);
  });

  it("reports a change for a row that is on but was never confirmed", async () => {
    const d = await repoHandler.desire(
      manifest({ autoMerge: true, autoMergeConfirmed: true }),
      {} as never,
    );
    const unconfirmed = { autoMerge: true, autoMergeConfirmedAt: null } as never;
    const confirmed = { autoMerge: true, autoMergeConfirmedAt: new Date() } as never;
    expect(await repoHandler.diff(unconfirmed, d, {} as never)).toContain("autoMergeConfirmed");
    expect(await repoHandler.diff(confirmed, d, {} as never)).toEqual([]);
  });
});

describe("kind: Repo — the deployment's git platforms (OPTIO_GIT_PLATFORMS)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a github.com repo when GitHub isn't offered, naming the platform", async () => {
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    const err = await repoHandler
      .desire(manifest({ url: "https://github.com/acme/widgets" }), {} as never)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ManifestError);
    expect(err.message).toBe("github isn't available in this deployment");
  });

  it("takes a GitLab repo with GitLab alone, and a GitHub one by default", async () => {
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    const gitlab = await repoHandler.desire(manifest({}), {} as never);
    expect(gitlab.fullName).toBe("acme/widgets");
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "");
    const github = await repoHandler.desire(
      manifest({ url: "https://github.com/acme/widgets" }),
      {} as never,
    );
    expect(github.url).toBe("https://github.com/acme/widgets");
  });
});
