import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const gitlabBotApi = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
const githubBotApi = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/gitlab-bot-api", () => ({ gitlabBotApi, githubBotApi }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { GitLabBotSettings } from "./gitlab-bot-settings";

const view = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  username: null,
  rateLimit: 5,
  rateWindowMinutes: 10,
  maxRateLimit: 100,
  source: { enabled: "environment", username: "token", rateLimit: "environment" },
  environment: { enabled: true, username: null, rateLimit: 5 },
  hosts: [{ host: "gitlab.example.test", username: "optio-bot", error: null }],
  canEdit: false,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GitLabBotSettings", () => {
  it("tells everyone whom to mention, without the admin's controls", async () => {
    gitlabBotApi.get.mockResolvedValue(view());
    render(<GitLabBotSettings />);
    expect((await screen.findAllByText("@optio-bot")).length).toBe(2); // summary + host row
    expect(screen.getByTestId("gitlab-bot-hosts").textContent).toContain(
      "On gitlab.example.test, mention @optio-bot",
    );
    expect(screen.queryByLabelText("Bot's GitLab username")).toBeNull();
  });

  it("says when the bot's user can't be found", async () => {
    gitlabBotApi.get.mockResolvedValue(
      view({
        hosts: [{ host: "gitlab.example.test", username: null, error: "GitLab answered 401" }],
      }),
    );
    render(<GitLabBotSettings />);
    expect((await screen.findByTestId("gitlab-bot-hosts")).textContent).toContain(
      "couldn't tell who its GitLab user is (GitLab answered 401)",
    );
  });

  it("lets a deployment admin name the bot, change the limit and go back to the token's user", async () => {
    gitlabBotApi.get.mockResolvedValue(view({ canEdit: true }));
    gitlabBotApi.update.mockResolvedValue(
      view({
        canEdit: true,
        username: "svc-optio",
        rateLimit: 3,
        source: { enabled: "environment", username: "app", rateLimit: "app" },
        hosts: [{ host: "gitlab.example.test", username: "svc-optio", error: null }],
      }),
    );
    render(<GitLabBotSettings />);
    const nameInput = await screen.findByLabelText("Bot's GitLab username");
    fireEvent.change(nameInput, { target: { value: "svc-optio" } });
    fireEvent.change(screen.getByLabelText("Requests per person per merge request or issue"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(gitlabBotApi.update).toHaveBeenCalledWith({ username: "svc-optio", rateLimit: 3 }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Use the token's user" }));
    await waitFor(() => expect(gitlabBotApi.update).toHaveBeenLastCalledWith({ useToken: true }));
  });

  it("turns the bot off", async () => {
    gitlabBotApi.get.mockResolvedValue(view({ canEdit: true }));
    gitlabBotApi.update.mockResolvedValue(view({ canEdit: true, enabled: false }));
    render(<GitLabBotSettings />);
    fireEvent.click(await screen.findByLabelText("Answer mentions"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(gitlabBotApi.update).toHaveBeenCalledWith({ enabled: false }));
    expect(await screen.findByText("Off")).toBeTruthy();
  });

  it("the GitHub card asks the GitHub bot's settings and names the App's bot", async () => {
    githubBotApi.get.mockResolvedValue(
      view({ hosts: [{ host: "github.com", username: "optio-app", error: null }], canEdit: true }),
    );
    render(<GitLabBotSettings platform="github" />);
    expect(await screen.findByTestId("github-bot-hosts")).toHaveTextContent(
      "On github.com, mention @optio-app",
    );
    expect(screen.getByLabelText("Bot's GitHub username")).toBeTruthy();
    expect(screen.getByText("The GitHub App's")).toBeTruthy();
    expect(gitlabBotApi.get).not.toHaveBeenCalled();
  });
});
