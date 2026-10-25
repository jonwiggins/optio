import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ browse: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api: { browseRepos: mocks.browse } }));
vi.mock("@/lib/gitlab-instances-api", () => ({ gitlabInstancesApi: { list: mocks.list } }));
import { GitLabRepoBrowser } from "./gitlab-repo-browser";
afterEach(cleanup);

describe("GitLab repository instance switch", () => {
  it("switches browsing to the chosen configured base URL", async () => {
    mocks.list.mockResolvedValue({
      canEdit: false,
      instances: [
        {
          id: "1",
          displayName: "Other GitLab",
          baseUrl: "https://git.example.com:8443/gitlab",
          source: "app",
        },
      ],
    });
    mocks.browse.mockResolvedValue({ repos: [], platform: "gitlab", host: "gitlab.com" });
    render(<GitLabRepoBrowser selected={null} onPick={vi.fn()} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "GitLab instance" }), {
      target: { value: "https://git.example.com:8443/gitlab" },
    });
    await waitFor(() =>
      expect(mocks.browse).toHaveBeenLastCalledWith({
        q: undefined,
        platform: "gitlab",
        instance: "https://git.example.com:8443/gitlab",
      }),
    );
  });
});
