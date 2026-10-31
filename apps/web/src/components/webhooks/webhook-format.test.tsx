import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const updateWebhook = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { updateWebhook: (...a: unknown[]) => updateWebhook(...a) },
}));

import { WebhookFormatCard, WebhookFormatSelect, formatLabel } from "./webhook-format";

afterEach(() => cleanup());

describe("webhook body format", () => {
  it("offers the formats (chat services alphabetically) and the guess by URL, with a hint for the one picked", () => {
    const onChange = vi.fn();
    render(<WebhookFormatSelect value="mattermost" onChange={onChange} />);
    const select = screen.getByLabelText("Body format") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "By the URL",
      "Optio JSON",
      "Discord",
      "Google Chat",
      "Mattermost",
      "Microsoft Teams",
      "Rocket.Chat",
      "Slack",
      "Webex",
      "Zulip",
    ]);
    expect(
      screen.getByText(/Markdown message for a Mattermost incoming webhook/),
    ).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "msteams" } });
    expect(onChange).toHaveBeenCalledWith("msteams");
  });

  it("says what By the URL sends to a URL only one chat service uses", () => {
    const { rerender } = render(
      <WebhookFormatSelect
        value=""
        onChange={vi.fn()}
        url="https://discord.com/api/webhooks/1234/abc"
      />,
    );
    expect(screen.getByText(/^Discord, by this URL\. An embed/)).toBeInTheDocument();
    rerender(
      <WebhookFormatSelect value="" onChange={vi.fn()} url="https://receiver.example.com/x" />,
    );
    expect(screen.getByText(/Optio's JSON for anything else/)).toBeInTheDocument();
    // A chosen format is what's sent, whatever the URL.
    rerender(
      <WebhookFormatSelect
        value="generic"
        onChange={vi.fn()}
        url="https://discord.com/api/webhooks/1234/abc"
      />,
    );
    expect(screen.getByText(/for your own receiver/)).toBeInTheDocument();
  });

  it("names a format, and nothing for none", () => {
    expect(formatLabel("rocketchat")).toBe("Rocket.Chat");
    expect(formatLabel("msteams")).toBe("Microsoft Teams");
    expect(formatLabel(null)).toBeNull();
  });

  it("changes an existing webhook's format (back to the guess with null)", async () => {
    updateWebhook.mockResolvedValue({});
    const onChanged = vi.fn();
    render(<WebhookFormatCard webhook={{ id: "wh-1", format: "slack" }} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("Body format"), { target: { value: "" } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(updateWebhook).toHaveBeenCalledWith("wh-1", { format: null });
  });
});
