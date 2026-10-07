import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { AgentCredential, AgentCredentialMethodOption } from "@optio/shared";

const api = vi.hoisted(() => ({
  verifyAgentCredential: vi.fn(),
  createAgentCredential: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));

import { AddCredentialDialog } from "./add-credential-dialog";

const addable: AgentCredentialMethodOption[] = [
  {
    secretName: "ANTHROPIC_API_KEY",
    method: "api-key",
    label: "Anthropic API key",
    input: "token",
    verifiable: true,
    hint: "From console.anthropic.com.",
  },
  {
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    method: "oauth-token",
    label: "Claude subscription (OAuth token)",
    input: "token",
    verifiable: false,
  },
];

const stored: AgentCredential = {
  id: "secret:11111111-1111-4111-8111-111111111111",
  kind: "secret",
  method: "api-key",
  label: "Anthropic API key",
  secretName: "ANTHROPIC_API_KEY",
  owner: "me",
  default: false,
};

beforeAll(() => {
  // jsdom has no <dialog> modality.
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(over: Partial<Parameters<typeof AddCredentialDialog>[0]> = {}) {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  render(
    <AddCredentialDialog
      agentType="claude-code"
      agentLabel="Claude Code"
      addable={addable}
      isAdmin={false}
      initialOwner="workspace"
      onClose={onClose}
      onAdded={onAdded}
      {...over}
    />,
  );
  return { onAdded, onClose };
}

describe("AddCredentialDialog", () => {
  it("offers each method and Bedrock, keeps the value hidden, and saves as private for a member", async () => {
    api.createAgentCredential.mockResolvedValue({ credential: stored });
    const { onAdded } = mount();
    expect(screen.getByTestId("credential-method-ANTHROPIC_API_KEY")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("credential-method-CLAUDE_CODE_OAUTH_TOKEN")).toBeInTheDocument();
    expect(screen.getByTestId("credential-method-bedrock")).toBeInTheDocument();
    // A member can only make their own; the organization pill says why.
    expect(screen.getByRole("button", { name: /Organization/ })).toBeDisabled();

    const value = screen.getByTestId("credential-value") as HTMLInputElement;
    expect(value.type).toBe("password");
    fireEvent.change(value, { target: { value: "  sk-ant-test  " } });
    fireEvent.click(screen.getByRole("button", { name: "Show the value" }));
    expect(value.type).toBe("text");

    fireEvent.click(screen.getByTestId("credential-save"));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(stored));
    expect(api.createAgentCredential).toHaveBeenCalledWith({
      agentType: "claude-code",
      secretName: "ANTHROPIC_API_KEY",
      value: "sk-ant-test",
      owner: "me",
      verify: true,
    });
  });

  it("Test checks the value and a passed check is not repeated on save", async () => {
    api.verifyAgentCredential.mockResolvedValue({ valid: true, detail: "12 models" });
    api.createAgentCredential.mockResolvedValue({ credential: stored });
    mount({ isAdmin: true });
    fireEvent.change(screen.getByTestId("credential-value"), { target: { value: "sk-ant-ok" } });
    fireEvent.click(screen.getByTestId("credential-verify"));
    await waitFor(() =>
      expect(screen.getByTestId("credential-verify-result")).toHaveTextContent("Works · 12 models"),
    );
    expect(api.verifyAgentCredential).toHaveBeenCalledWith({
      agentType: "claude-code",
      secretName: "ANTHROPIC_API_KEY",
      value: "sk-ant-ok",
    });
    fireEvent.click(screen.getByTestId("credential-save"));
    await waitFor(() => expect(api.createAgentCredential).toHaveBeenCalled());
    expect(api.createAgentCredential.mock.calls[0][0]).toMatchObject({
      owner: "workspace",
      verify: false,
    });
  });

  it("unticking the check skips verification; a rejected save shows the server's reason", async () => {
    api.createAgentCredential.mockRejectedValue(new Error("The service rejected it: 401"));
    const { onAdded } = mount({ isAdmin: true });
    fireEvent.change(screen.getByTestId("credential-value"), { target: { value: "sk-bad" } });
    fireEvent.click(screen.getByTestId("credential-verify-toggle"));
    fireEvent.click(screen.getByTestId("credential-save"));
    await waitFor(() =>
      expect(screen.getByTestId("credential-error")).toHaveTextContent(
        "The service rejected it: 401",
      ),
    );
    expect(api.createAgentCredential.mock.calls[0][0]).toMatchObject({ verify: false });
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("a non-verifiable method has no Test button or check box", () => {
    mount();
    fireEvent.click(screen.getByTestId("credential-method-CLAUDE_CODE_OAUTH_TOKEN"));
    expect(screen.queryByTestId("credential-verify")).toBeNull();
    expect(screen.queryByTestId("credential-verify-toggle")).toBeNull();
    expect((screen.getByTestId("credential-value") as HTMLInputElement).type).toBe("password");
  });

  it("Bedrock explains itself and links to Settings instead of a form", () => {
    mount();
    fireEvent.click(screen.getByTestId("credential-method-bedrock"));
    expect(screen.queryByTestId("credential-value")).toBeNull();
    expect(screen.queryByTestId("credential-save")).toBeNull();
    expect(screen.getByTestId("credential-bedrock-link")).toHaveAttribute(
      "href",
      "/settings#model-providers",
    );
  });
});
