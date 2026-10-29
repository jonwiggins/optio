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
