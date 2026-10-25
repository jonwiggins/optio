import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const api = vi.hoisted(() => ({ save: vi.fn(), statuses: vi.fn(), check: vi.fn() }));
vi.mock("@/lib/ticket-round-trip-api", () => ({ ticketRoundTripApi: api }));

import { toast } from "sonner";
import { TicketRoundTrip } from "./ticket-round-trip";

const provider = (roundTrip?: Record<string, unknown>, source = "jira") => ({
  id: "p-1",
  source,
  config: { baseUrl: "https://jira.example.com", ...(roundTrip ? { roundTrip } : {}) },
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.statuses.mockResolvedValue({
    scope: "project",
    statuses: [{ name: "To Do" }, { name: "In Progress" }, { name: "In Review" }, { name: "Done" }],
  });
});
afterEach(() => cleanup());

const openPanel = async () => {
  fireEvent.click(screen.getByRole("button", { name: /Round trip/ }));
  await waitFor(() => expect(api.statuses).toHaveBeenCalledWith("p-1"));
};

describe("a provider's round trip", () => {
  it("is closed until asked for, and reads the statuses only then", () => {
    render(<TicketRoundTrip provider={provider()} />);
    expect(screen.queryByText("Comment on the ticket")).toBeNull();
    expect(api.statuses).not.toHaveBeenCalled();
  });

  it("starts off, with the defaults for when it is switched on", async () => {
    render(<TicketRoundTrip provider={provider()} />);
    await openPanel();
    expect(
      (screen.getByLabelText(/Write back to the Jira tickets/) as HTMLInputElement).checked,
    ).toBe(false);
    expect((screen.getByLabelText(/Comment on the ticket/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Link the run/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Any comment" }).className).toContain("bg-primary");
    const started = screen.getByLabelText("Status when: Work started") as HTMLSelectElement;
    expect(started.value).toBe("");
  });

  it("maps statuses picked from the project's and saves everything", async () => {
    api.save.mockImplementation(async (_id, roundTrip) => ({ roundTrip }));
    render(<TicketRoundTrip provider={provider()} />);
    await openPanel();
    await waitFor(() =>
      expect(screen.getByLabelText("Status when: Work started")).not.toHaveProperty(
        "disabled",
        true,
      ),
    );
    fireEvent.change(screen.getByLabelText("Status when: Work started"), {
      target: { value: "In Progress" },
    });
    fireEvent.change(screen.getByLabelText("Status when: Merge request opened"), {
      target: { value: "In Review" },
    });
    fireEvent.click(screen.getByLabelText(/Link the run/));
    fireEvent.click(screen.getByRole("button", { name: "Mentions only" }));
    fireEvent.click(screen.getByLabelText(/Write back to the Jira tickets/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect(api.save).toHaveBeenCalledWith("p-1", {
      enabled: true,
      comments: true,
      remoteLink: false,
      followUps: "mention",
      transitions: { started: "In Progress", mrOpened: "In Review", merged: "", failed: "" },
    });
    expect(toast.success).toHaveBeenCalledWith("Round trip saved");
  });

  it("keeps a saved status the server no longer lists", async () => {
    render(
      <TicketRoundTrip
        provider={provider({
          transitions: { started: "Doing", mrOpened: "", merged: "", failed: "" },
        })}
      />,
    );
    await openPanel();
    await waitFor(() =>
      expect((screen.getByLabelText("Status when: Work started") as HTMLSelectElement).value).toBe(
        "Doing",
      ),
    );
  });

  it("tests the form's mapping on an issue and says what it found", async () => {
    api.check.mockResolvedValue({
      ok: true,
      issueKey: "PLAT-1",
      status: "To Do",
      available: ["In Progress", "Done"],
      steps: [
        { step: "started", status: "In Progress", outcome: "ready" },
        { step: "mrOpened", status: "In Review", outcome: "unreachable" },
      ],
    });
    render(
      <TicketRoundTrip
        provider={provider({
          transitions: { started: "In Progress", mrOpened: "In Review", merged: "", failed: "" },
        })}
      />,
    );
    await openPanel();
    fireEvent.change(screen.getByLabelText("Issue key"), { target: { value: " PLAT-1 " } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByTestId("round-trip-check")).toBeTruthy());
    expect(api.check).toHaveBeenCalledWith("p-1", "PLAT-1", {
      started: "In Progress",
      mrOpened: "In Review",
      merged: "",
      failed: "",
    });
    const out = screen.getByTestId("round-trip-check").textContent ?? "";
    expect(out).toContain("PLAT-1 is in To Do; it can move to In Progress, Done.");
    expect(out).toContain("Work started → In Progress: can move there now");
    expect(out).toContain("Merge request opened → In Review: no transition leads there from here");
  });

  it("says why a save or a test failed", async () => {
    api.save.mockRejectedValue(new Error("Only a workspace admin can change this ticket provider"));
    api.check.mockRejectedValue(new Error("Provider not found"));
    render(<TicketRoundTrip provider={provider()} />);
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't save the round trip", {
        description: "Only a workspace admin can change this ticket provider",
      }),
    );
    fireEvent.change(screen.getByLabelText("Issue key"), { target: { value: "PLAT-9" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByText("Provider not found")).toBeTruthy());
  });

  it("for a GitHub provider: its statuses, its kind of link, an issue number to test", async () => {
    api.statuses.mockResolvedValue({
      scope: "repository",
      statuses: [
        { name: "Open", category: "State" },
        { name: "Closed", category: "State" },
        { name: "in review", category: "Label" },
      ],
    });
    render(<TicketRoundTrip provider={provider({ enabled: true }, "github")} />);
    fireEvent.click(screen.getByRole("button", { name: /Round trip \(on\)/ }));
    await waitFor(() => expect(api.statuses).toHaveBeenCalledWith("p-1"));
    expect(screen.getByText(/One comment by Optio per piece of work/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Any comment" })).toBeTruthy();
    expect(screen.getByLabelText("Follow-ups from GitHub")).toBeTruthy();
    expect((screen.getByLabelText("Issue key") as HTMLInputElement).placeholder).toBe("12");
    // Every step's picker offers the repository's states and labels.
    await waitFor(() =>
      expect(screen.getAllByRole("option", { name: "in review" })).toHaveLength(4),
    );
  });

  it("for a Notion provider: no link to keep, so no link setting", async () => {
    render(<TicketRoundTrip provider={provider(undefined, "notion")} />);
    await openPanel();
    expect(screen.queryByLabelText(/Link the run/)).toBeNull();
    expect(screen.getByLabelText(/Comment on the ticket/)).toBeTruthy();
  });

  it("nothing for a source without a round trip", () => {
    const { container } = render(<TicketRoundTrip provider={provider(undefined, "trello")} />);
    expect(container.innerHTML).toBe("");
  });
});
