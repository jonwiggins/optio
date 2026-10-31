import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SmtpSettingsView } from "@/lib/notify-api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let currentUser: any;
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

const getSmtpSettings = vi.fn();
const saveSmtpSettings = vi.fn();
const deleteSmtpSettings = vi.fn();
const sendTestEmail = vi.fn();
vi.mock("@/lib/notify-api", () => ({
  notifyApi: {
    getSmtpSettings: () => getSmtpSettings(),
    saveSmtpSettings: (b: unknown) => saveSmtpSettings(b),
    deleteSmtpSettings: () => deleteSmtpSettings(),
    sendTestEmail: (b: unknown) => sendTestEmail(b),
  },
}));

import { bodyOf, EmailSettings } from "./email-settings";

const empty: SmtpSettingsView = {
  configured: false,
  source: null,
  enabled: false,
  host: "",
  port: null,
  security: "starttls",
  username: null,
  hasPassword: false,
  from: "Optio <optio@optio.example.test>",
  caPem: null,
  insecureSkipVerify: false,
  envConfigured: false,
  envError: null,
};

const saved: SmtpSettingsView = {
  ...empty,
  configured: true,
  source: "app",
  enabled: true,
  host: "relay.example.test",
  port: 587,
  security: "starttls-required",
  username: "optio",
  hasPassword: true,
};

beforeEach(() => {
  currentUser = {
    user: { id: "u1", email: "root@example.test" },
    isDeploymentAdmin: true,
    loaded: true,
  };
  getSmtpSettings.mockReset();
  saveSmtpSettings.mockReset();
  deleteSmtpSettings.mockReset();
  sendTestEmail.mockReset();
});
afterEach(() => cleanup());

describe("Settings → Notifications → Email", () => {
  it("is not there for someone who isn't a deployment admin", () => {
    currentUser = { ...currentUser, isDeploymentAdmin: false };
    const { container } = render(<EmailSettings />);
    expect(container).toBeEmptyDOMElement();
    expect(getSmtpSettings).not.toHaveBeenCalled();
  });

  it("saves the relay; a blank password keeps the stored one", async () => {
    getSmtpSettings.mockResolvedValue({ settings: saved });
    saveSmtpSettings.mockResolvedValue({ settings: saved });
    render(<EmailSettings />);
    expect(await screen.findByDisplayValue("relay.example.test")).toBeInTheDocument();
    expect(
      screen.getByText("Stored. Leave empty to keep it (same host and user name only)."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("SMTP port"), { target: { value: "2525" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveSmtpSettings).toHaveBeenCalled());
    expect(saveSmtpSettings.mock.calls[0][0]).toMatchObject({
      host: "relay.example.test",
      port: 2525,
      security: "starttls-required",
      username: "optio",
      password: "",
      enabled: true,
    });
  });

  it("sends a test email with the form as it stands and shows the relay's answer", async () => {
    getSmtpSettings.mockResolvedValue({ settings: empty });
    sendTestEmail.mockResolvedValue({
      ok: false,
      to: "root@example.test",
      error: "The relay refused the user name or password (535 5.7.8)",
    });
    render(<EmailSettings />);
    fireEvent.change(await screen.findByLabelText("SMTP host"), {
      target: { value: "relay.example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Not sent to root@example.test: The relay refused the user name or password (535 5.7.8)",
    );
    expect(sendTestEmail).toHaveBeenCalledWith({
      to: undefined,
      settings: expect.objectContaining({ host: "relay.example.test", security: "starttls" }),
    });
  });

  it("shows why the deployment's relay can't be used, and goes back to it", async () => {
    getSmtpSettings.mockResolvedValue({
      settings: { ...saved, envConfigured: true, envError: "Set OPTIO_SMTP_FROM" },
    });
    deleteSmtpSettings.mockResolvedValue({ settings: { ...empty, source: "env" } });
    render(<EmailSettings />);
    expect(await screen.findByTestId("env-error")).toHaveTextContent("Set OPTIO_SMTP_FROM");
    fireEvent.click(screen.getByRole("button", { name: "Use the deployment's" }));
    await waitFor(() => expect(deleteSmtpSettings).toHaveBeenCalled());
  });
});

describe("bodyOf", () => {
  const draft = {
    host: " relay ",
    port: "",
    security: "tls" as const,
    username: "",
    password: "pw",
    clearPassword: false,
    from: "optio@example.test",
    caPem: "",
    insecureSkipVerify: false,
    enabled: true,
  };

  it("sends what the API takes", () => {
    expect(bodyOf(draft)).toEqual({
      host: "relay",
      port: null,
      security: "tls",
      username: null,
      password: "pw",
      from: "optio@example.test",
      caPem: null,
      insecureSkipVerify: false,
      enabled: true,
    });
    expect(bodyOf({ ...draft, clearPassword: true })).toMatchObject({ password: null });
  });

  it("says what's missing", () => {
    expect(bodyOf({ ...draft, host: "" })).toBe("Give the relay's host name");
    expect(bodyOf({ ...draft, port: "99999" })).toBe("The port is a number from 1 to 65535");
  });
});
