import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const getEnvironmentMirrors = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getEnvironmentMirrors: () => getEnvironmentMirrors() },
}));

import { MirrorWarning, mirrorsNeeded, mirrorMessage, _resetMirrors } from "./mirror-warning";

beforeEach(() => {
  getEnvironmentMirrors.mockReset();
  _resetMirrors();
});

afterEach(() => {
  cleanup();
});

describe("mirrorsNeeded", () => {
  it("names the registry each tool reads", () => {
    expect(mirrorsNeeded("npx", "-y foo")).toEqual(["npm"]);
    expect(mirrorsNeeded("my-server", "npm install -g my-server@1.2.3")).toEqual(["npm"]);
    expect(mirrorsNeeded("uvx")).toEqual(["uv"]);
    expect(mirrorsNeeded(null, "pip install my-mcp && uv tool install x")).toEqual(["pip", "uv"]);
    expect(mirrorsNeeded("node", "/opt/tools/mcp.js")).toEqual([]);
    expect(mirrorsNeeded("/usr/bin/npx-wrapper")).toEqual([]);
  });

  it("says which variable to set", () => {
    expect(mirrorMessage("npm")).toBe(
      "needs the npm mirror (Artifactory) — set agent.env.NPM_CONFIG_REGISTRY",
    );
    expect(mirrorMessage("uv")).toContain("UV_DEFAULT_INDEX");
  });
});

describe("MirrorWarning", () => {
  it("warns when the command needs a mirror the deployment lacks", async () => {
    getEnvironmentMirrors.mockResolvedValue({ npm: false, pip: true, uv: false });
    render(<MirrorWarning command="npx" installCommand="" />);
    await waitFor(() =>
      expect(screen.getByRole("note").textContent).toContain(
        "needs the npm mirror (Artifactory) — set agent.env.NPM_CONFIG_REGISTRY",
      ),
    );
  });

  it("stays quiet when the mirror is there, or the command needs none", async () => {
    getEnvironmentMirrors.mockResolvedValue({ npm: true, pip: false, uv: false });
    render(<MirrorWarning command="npx" installCommand="" />);
    await waitFor(() => expect(getEnvironmentMirrors).toHaveBeenCalled());
    expect(screen.queryByRole("note")).toBeNull();
    cleanup();
    render(<MirrorWarning command="node" installCommand="" />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("stays quiet when the API cannot say", async () => {
    getEnvironmentMirrors.mockRejectedValue(new Error("404"));
    render(<MirrorWarning command="npx" />);
    await waitFor(() => expect(getEnvironmentMirrors).toHaveBeenCalled());
    expect(screen.queryByRole("note")).toBeNull();
  });
});
