import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TriggerSelector, cronIsValid, describeCronPreset } from "./trigger-selector";
import { evenColumns } from "./ui/segmented";
import type { TriggerConfig } from "./trigger-selector";

afterEach(() => {
  cleanup();
});

describe("TriggerSelector", () => {
  describe("trigger type buttons", () => {
    it("renders manual, schedule, webhook, and ticket buttons by default", () => {
      const onChange = vi.fn();
      render(<TriggerSelector value={{ type: "manual" }} onChange={onChange} />);
      expect(screen.getByText("Manual")).toBeInTheDocument();
      expect(screen.getByText("Schedule")).toBeInTheDocument();
      expect(screen.getByText("Webhook")).toBeInTheDocument();
      expect(screen.getByText("Ticket")).toBeInTheDocument();
    });

    it("hides manual when hideManual is true", () => {
      const onChange = vi.fn();
      render(
        <TriggerSelector
          value={{ type: "schedule", cronExpression: "0 9 * * *" }}
          onChange={onChange}
          hideManual
        />,
      );
      expect(screen.queryByText("Manual")).not.toBeInTheDocument();
      expect(screen.getByText("Schedule")).toBeInTheDocument();
      expect(screen.getByText("Webhook")).toBeInTheDocument();
      expect(screen.getByText("Ticket")).toBeInTheDocument();
    });
  });

  describe("type pill layout", () => {
    it("lays the built-in pills out in one row of four", () => {
      render(<TriggerSelector value={{ type: "manual" }} onChange={vi.fn()} />);
      expect(screen.getByRole("group")).toHaveClass("grid", "sm:grid-cols-4");
    });

    it("splits many pills into rows as even as possible", () => {
      const extra = ["GitHub", "Slack", "Linear", "PagerDuty"].map((l) => (
        <button key={l} type="button">
          {l}
        </button>
      ));
      render(<TriggerSelector value={{ type: "manual" }} onChange={vi.fn()} extra={extra} />);
      // 8 pills: two rows of 4, not 6 + 2 (11 would be 6 + 5).
      expect(screen.getByRole("group")).toHaveClass("sm:grid-cols-4");
    });

    it("evenColumns divides the pills into even rows under the per-row cap", () => {
      expect(evenColumns(4, 6)).toBe(4);
      expect(evenColumns(6, 6)).toBe(6);
      expect(evenColumns(8, 6)).toBe(4);
      expect(evenColumns(9, 6)).toBe(5);
      expect(evenColumns(11, 6)).toBe(6);
      expect(evenColumns(12, 6)).toBe(6);
      expect(evenColumns(0, 6)).toBe(1);
    });
  });

  describe("ticket trigger config panel", () => {
    it("shows source dropdown and labels input when ticket type is selected", () => {
      const onChange = vi.fn();
      render(
        <TriggerSelector
          value={{ type: "ticket", ticketSource: "github", ticketLabels: [] }}
          onChange={onChange}
        />,
      );
      expect(screen.getByLabelText(/source/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/labels/i)).toBeInTheDocument();
    });

    it("renders source dropdown with github, linear, jira, notion options", () => {
      const onChange = vi.fn();
      render(
        <TriggerSelector
          value={{ type: "ticket", ticketSource: "github", ticketLabels: [] }}
          onChange={onChange}
        />,
      );
      const select = screen.getByLabelText(/source/i) as HTMLSelectElement;
      expect(select.tagName).toBe("SELECT");
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain("github");
      expect(options).toContain("linear");
      expect(options).toContain("jira");
      expect(options).toContain("notion");
    });

    it("calls onChange with updated source when source is changed", () => {
      const onChange = vi.fn();
      render(
        <TriggerSelector
          value={{ type: "ticket", ticketSource: "github", ticketLabels: [] }}
          onChange={onChange}
        />,
      );
      const select = screen.getByLabelText(/source/i) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "linear" } });
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ticket", ticketSource: "linear" }),
      );
    });

    it("defaults ticket source to github when switching to ticket type", () => {
      const onChange = vi.fn();
      render(<TriggerSelector value={{ type: "manual" }} onChange={onChange} />);
      fireEvent.click(screen.getByText("Ticket"));
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ticket", ticketSource: "github", ticketLabels: [] }),
      );
    });

    it("preserves existing ticket config when re-selecting ticket type", () => {
      const onChange = vi.fn();
      render(
        <TriggerSelector
          value={{ type: "ticket", ticketSource: "linear", ticketLabels: ["bug"] }}
          onChange={onChange}
        />,
      );
      // Source should show current value
      const select = screen.getByLabelText(/source/i) as HTMLSelectElement;
      expect(select.value).toBe("linear");
    });

    it("does not show ticket config panel for other trigger types", () => {
      const onChange = vi.fn();
      render(
        <TriggerSelector
          value={{ type: "schedule", cronExpression: "0 9 * * *" }}
          onChange={onChange}
        />,
      );
      expect(screen.queryByLabelText(/source/i)).not.toBeInTheDocument();
    });
  });

  describe("ticket labels", () => {
    it("adds a label when typed and Enter is pressed", () => {
      const onChange = vi.fn();
      render(
        <TriggerSelector
          value={{ type: "ticket", ticketSource: "github", ticketLabels: [] }}
          onChange={onChange}
        />,
      );
      const input = screen.getByLabelText(/labels/i) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "cve" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ticketLabels: ["cve"] }));
    });

    it("renders existing labels as removable badges", () => {
      const onChange = vi.fn();
      render(
        <TriggerSelector
          value={{ type: "ticket", ticketSource: "github", ticketLabels: ["cve", "bug"] }}
          onChange={onChange}
        />,
      );
      expect(screen.getByText("cve")).toBeInTheDocument();
      expect(screen.getByText("bug")).toBeInTheDocument();
    });
  });

  describe("schedule trigger (existing behavior)", () => {
    it("shows cron expression input when schedule is selected", () => {
      const onChange = vi.fn();
      render(
        <TriggerSelector
          value={{ type: "schedule", cronExpression: "0 9 * * *" }}
          onChange={onChange}
        />,
      );
      expect(screen.getByDisplayValue("0 9 * * *")).toBeInTheDocument();
    });
  });

  describe("webhook trigger (existing behavior)", () => {
    it("shows webhook path input when webhook is selected", () => {
      const onChange = vi.fn();
      render(
        <TriggerSelector value={{ type: "webhook", webhookPath: "my-hook" }} onChange={onChange} />,
      );
      expect(screen.getByDisplayValue("my-hook")).toBeInTheDocument();
    });
  });
});

describe("cronIsValid", () => {
  it("returns true for valid five-field cron", () => {
    expect(cronIsValid("0 9 * * *")).toBe(true);
  });

  it("returns false for empty/null", () => {
    expect(cronIsValid("")).toBe(false);
    expect(cronIsValid(null)).toBe(false);
    expect(cronIsValid(undefined)).toBe(false);
  });

  it("returns false for wrong field count", () => {
    expect(cronIsValid("0 9 * *")).toBe(false);
    expect(cronIsValid("0 9 * * * *")).toBe(false);
  });
});

describe("describeCronPreset", () => {
  it("returns label for known presets", () => {
    expect(describeCronPreset("0 9 * * *")).toBe("Daily 09:00 UTC");
  });

  it("returns null for unknown expressions", () => {
    expect(describeCronPreset("0 12 * * *")).toBeNull();
  });
});
