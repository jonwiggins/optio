import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mock = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), test: vi.fn() }));
vi.mock("@/lib/gitlab-instances-api", () => ({ gitlabInstancesApi: mock }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { GitLabInstancesSettings } from "./gitlab-instances";

const app = {
  id: "app-1",
  baseUrl: "https://git.example.com/gitlab",
  displayName: "Test GitLab",
  caPem: null,
  hasToken: true,
  source: "app",
};
const env = {
  ...app,
  id: "env-1",
  baseUrl: "https://gitlab.com",
  displayName: "gitlab.com",
  source: "environment",
};
beforeEach(() => {
  mock.list.mockReset().mockResolvedValue({ instances: [app, env], canEdit: true });
  mock.save.mockReset().mockResolvedValue(app);
  mock.remove.mockReset().mockResolvedValue({ ok: true });
  mock.test.mockReset().mockResolvedValue({ ok: true, version: "18.0", username: "test-bot" });
});
afterEach(cleanup);

describe("GitLab instance Settings", () => {
  it("shows environment entries read-only and hides all editing for non-admins", async () => {
    mock.list.mockResolvedValue({ instances: [app, env], canEdit: false });
    render(<GitLabInstancesSettings />);
    expect(await screen.findByText("From the deployment · read only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add GitLab instance" })).toBeNull();
  });
  it("adds and tests unsaved settings without disclosing the password", async () => {
    render(<GitLabInstancesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Add GitLab instance" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Other" } });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://other.example.com/gitlab" },
    });
    expect(screen.getByText(/Personal tokens take precedence/)).toBeInTheDocument();
    expect(screen.getByText(/Private and loopback/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Default token"), {
      target: { value: "private-token" },
    });
    expect(screen.getByLabelText("Default token")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Connected to GitLab 18.0 as @test-bot",
    );
    expect(mock.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.save).toHaveBeenCalledWith(
        {
          displayName: "Other",
          baseUrl: "https://other.example.com/gitlab",
          caPem: null,
          token: "private-token",
        },
        undefined,
      ),
    );
  });
  it("preserves a saved token on edit and can explicitly clear it", async () => {
    render(<GitLabInstancesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Default token")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.save).toHaveBeenCalledWith(
        expect.not.objectContaining({ token: expect.anything() }),
        "app-1",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText("Remove saved token"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.save).toHaveBeenLastCalledWith(expect.objectContaining({ token: null }), "app-1"),
    );
  });
  it("reports a connection failure and removes only app-managed rows", async () => {
    mock.test.mockResolvedValue({ ok: false, error: "Certificate not trusted" });
    render(<GitLabInstancesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Certificate not trusted");
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mock.remove).toHaveBeenCalledWith("app-1"));
  });
});
