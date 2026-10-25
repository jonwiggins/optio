import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DirectorySyncRun, DirectorySyncView } from "@/lib/directory-sync-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

let currentUser: any;
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

const api = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  run: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
}));
vi.mock("@/lib/directory-sync-api", () => ({ directorySyncApi: api }));

import { DirectorySyncSettings, intervalLabel } from "./directory-sync-settings";

const run: DirectorySyncRun = {
  id: "run-1",
  trigger: "schedule",
  startedBy: null,
  status: "ok",
  checked: 12,
  changed: 1,
  disabled: 1,
  enabled: 0,
  errors: 0,
  error: null,
  details: [
    { userId: "u-carol", email: "carol@example.test", outcome: "disabled", reason: "gone" },
    { userId: "u-dana", email: "dana@example.test", outcome: "changed" },
  ],
  startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  finishedAt: new Date().toISOString(),
};

function viewOf(over: Partial<DirectorySyncView> = {}): DirectorySyncView {
  return {
    settings: {
      enabled: true,
      intervalMinutes: 30,
      source: { enabled: "environment", intervalMinutes: "environment" },
      environment: { enabled: true, intervalMinutes: 30, maxDisablePercent: 25 },
      maxDisablePercent: 25,
    },
    ldapConfigured: true,
    note: null,
    running: false,
    lastRun: run,
    disabledPeople: [
      {
        id: "u-carol",
        email: "carol@example.test",
        displayName: "Carol Cohen",
        disabledAt: new Date().toISOString(),
        reason: "gone",
        reasonLabel: "no longer in the directory",
        byHand: false,
        disabledBy: null,
        paused: [
          { name: "nightly report", kind: "standalone", path: "/jobs/j1", workspaceId: "ws-1" },
        ],
        pausedHidden: 2,
      },
    ],
    limits: { minIntervalMinutes: 15, maxIntervalMinutes: 1440 },
    ...over,
  };
}

beforeEach(() => {
  currentUser = { user: { id: "op" }, isDeploymentAdmin: true, loaded: true };
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => cleanup());

describe("Settings → Access → Directory sync", () => {
  it("is not there for someone who isn't a deployment admin", () => {
    currentUser = { ...currentUser, isDeploymentAdmin: false };
    const { container } = render(<DirectorySyncSettings />);
    expect(container).toBeEmptyDOMElement();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("shows the schedule, the last run and who is disabled with what was paused", async () => {
    api.get.mockResolvedValue(viewOf());
    render(<DirectorySyncSettings />);
    expect(await screen.findByText("Every 30 minutes")).toBeInTheDocument();
    const last = screen.getByTestId("last-run");
    expect(within(last).getByText("Done")).toBeInTheDocument();
    expect(within(last).getByText(/12 checked · 1 changed · 1 disabled/)).toBeInTheDocument();
    const people = screen.getByTestId("disabled-people");
    expect(within(people).getByText("Carol Cohen")).toBeInTheDocument();
    expect(within(people).getByText("no longer in the directory")).toBeInTheDocument();
    expect(within(people).getByRole("link", { name: "nightly report" })).toHaveAttribute(
      "href",
      "/jobs/j1",
    );
    expect(within(people).getByText(/2 more paused in workspaces/)).toBeInTheDocument();
  });

  it("saves a new interval, and puts both back to the deployment's", async () => {
    api.get.mockResolvedValue(viewOf());
    const saved = viewOf({
      settings: {
        ...viewOf().settings,
        intervalMinutes: 60,
        source: { enabled: "environment", intervalMinutes: "app" },
      },
    });
    api.update.mockResolvedValue(saved);
    render(<DirectorySyncSettings />);
    const save = await screen.findByRole("button", { name: "Save schedule" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Interval"), { target: { value: "60" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 60 }),
    );
    api.update.mockResolvedValue(viewOf());
    fireEvent.click(await screen.findByRole("button", { name: "Use the deployment's" }));
    await waitFor(() =>
      expect(api.update).toHaveBeenLastCalledWith({ enabled: null, intervalMinutes: null }),
    );
  });

  it("runs now; a held run offers to disable them anyway", async () => {
    const held: DirectorySyncRun = {
      ...run,
      id: "run-2",
      trigger: "manual",
      status: "held",
      disabled: 0,
      error: "This run would disable 9 of the 12 people it checked",
      details: [
        { userId: "u-x", email: "x@example.test", outcome: "would_disable", reason: "gone" },
      ],
    };
    api.get.mockResolvedValueOnce(viewOf()).mockResolvedValue(viewOf({ lastRun: held }));
    api.run.mockResolvedValue(held);
    render(<DirectorySyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(api.run).toHaveBeenCalledWith(false));
    expect(await screen.findByText(/would disable 9 of the 12/)).toBeInTheDocument();
    expect(screen.getByText("would be disabled (gone)")).toBeInTheDocument();
    api.run.mockResolvedValue({ ...held, status: "ok", error: null });
    fireEvent.click(screen.getByRole("button", { name: "Disable them anyway" }));
    await waitFor(() => expect(api.run).toHaveBeenLastCalledWith(true));
  });

  it("disables someone by hand after a confirmation, and enables someone again", async () => {
    api.get.mockResolvedValue(viewOf());
    api.disable.mockResolvedValue({
      id: "u-sam",
      email: "sam@example.test",
      displayName: "Sam",
      disabled: true,
      revokedSessions: 2,
      revokedApiKeys: 1,
      paused: 0,
    });
    api.enable.mockResolvedValue({
      id: "u-carol",
      email: "carol@example.test",
      displayName: "Carol Cohen",
      disabled: false,
      resumed: 1,
    });
    render(<DirectorySyncSettings />);
    fireEvent.change(await screen.findByLabelText("Email of the person to disable"), {
      target: { value: " sam@example.test " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(api.disable).not.toHaveBeenCalled();
    const confirm = await screen.findByTestId("confirm-popover");
    expect(confirm).toHaveTextContent("Disable sam@example.test?");
    fireEvent.click(within(confirm).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(api.disable).toHaveBeenCalledWith({ email: "sam@example.test" }));

    fireEvent.click(screen.getByRole("button", { name: "Enable Carol Cohen" }));
    await waitFor(() => expect(api.enable).toHaveBeenCalledWith("u-carol"));
  });

  it("says the sync needs LDAP sign-in and can't run without it", async () => {
    api.get.mockResolvedValue(
      viewOf({
        ldapConfigured: false,
        note: "Directory sync reads LDAP / Active Directory, and LDAP sign-in isn't set up.",
        lastRun: null,
        disabledPeople: [],
      }),
    );
    render(<DirectorySyncSettings />);
    expect(await screen.findByTestId("ldap-needed")).toHaveTextContent(/LDAP sign-in isn't set up/);
    expect(screen.getByText("Needs LDAP sign-in")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(screen.getByText("Nobody is disabled.")).toBeInTheDocument();
  });

  it("names intervals the way people say them", () => {
    expect(intervalLabel(15)).toBe("15 minutes");
    expect(intervalLabel(60)).toBe("1 hour");
    expect(intervalLabel(240)).toBe("4 hours");
    expect(intervalLabel(1440)).toBe("1 day");
    expect(intervalLabel(45)).toBe("45 minutes");
  });
});
