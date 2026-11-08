import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOptioChatStore, type OptioConversationStore } from "@/hooks/use-optio-chat";
import { OptioChatPanel } from "./optio-chat-panel";

const harness = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; title: string }>,
  connections: new Map<
    string,
    {
      store: OptioConversationStore;
      send: ReturnType<typeof vi.fn>;
      reset: ReturnType<typeof vi.fn>;
    }
  >(),
  list: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  end: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    listOptioSessions: harness.list,
    createOptioSession: harness.create,
    renameOptioSession: harness.rename,
    endOptioSession: harness.end,
    getOptioSettings: async () => ({
      settings: { confirmWrites: true, agentRuntime: "codex", model: "test-model" },
    }),
  },
}));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({ loaded: true, user: { id: "viewer", workspaceId: "workspace" } }),
}));
vi.mock("./use-panel-size", () => ({ usePanelSize: () => ({ style: {}, handle: () => ({}) }) }));
vi.mock("@/hooks/use-optio-connection", () => ({
  useOptioConnection: (store: OptioConversationStore, id: string) => {
    if (!harness.connections.has(id))
      harness.connections.set(id, {
        store,
        send: vi.fn(() => true),
        reset: vi.fn(() => store.getState().resetMessages()),
      });
    return {
      ...harness.connections.get(id),
      sessionHref: `/work/${id}`,
      decide: vi.fn(),
      reconnect: vi.fn(),
      cancelQueued: vi.fn(),
    };
  },
}));

let resize: () => void;
let width = 440;
let styles: HTMLStyleElement;
beforeEach(() => {
  vi.clearAllMocks();
  // jsdom does not load Tailwind; retain the desktop visibility rules used by
  // the mounted background conversations and inline management views.
  styles = document.createElement("style");
  styles.textContent = ".hidden { display: none } .lg\\:block { display: block }";
  document.head.append(styles);
  harness.connections.clear();
  harness.rows = Array.from({ length: 6 }, (_, i) => ({
    id: `session-${i}`,
    title: `Investigation ${i}`,
  }));
  harness.list.mockImplementation(async () => ({ sessions: [...harness.rows] }));
  harness.create.mockImplementation(async () => {
    const session = { id: `new-${harness.rows.length}`, title: "New session" };
    harness.rows.push(session);
    return { session };
  });
  harness.rename.mockImplementation(async (id: string, title: string) => {
    harness.rows = harness.rows.map((row) => (row.id === id ? { ...row, title } : row));
    return { session: harness.rows.find((row) => row.id === id) };
  });
  harness.end.mockImplementation(async (id: string) => {
    harness.rows = harness.rows.filter((row) => row.id !== id);
  });
  localStorage.clear();
  sessionStorage.clear();
  useOptioChatStore.setState({ isOpen: true, prefillInput: "", status: "ready" });
  width = 440;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  cleanup();
  styles.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (name: string) => screen.getByRole("button", { name });
const message = () => screen.getByRole("textbox", { name: "Message Optio" });
async function open() {
  render(<OptioChatPanel />);
  await screen.findByRole("tab", { name: "Investigation 0" });
}
async function choose(title: string) {
  fireEvent.click(button("All sessions"));
  fireEvent.click(
    within(screen.getByRole("region", { name: "All sessions" })).getByRole("button", {
      name: title,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName(title),
  );
}

describe("Optio Agent navigation", () => {
  it("keeps a readable selected tab as width changes, and finds overflow sessions without sending drafts", async () => {
    await open();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    fireEvent.change(message(), { target: { value: "Private draft" } });
    const background = harness.connections.get("session-5")!.store;
    act(() =>
      background.getState().addMessage({
        id: "reply",
        role: "assistant",
        content: "Finished investigating",
        timestamp: new Date().toISOString(),
      }),
    );
    expect(button("All sessions")).toHaveAccessibleDescription("1 session has a new reply");
    fireEvent.click(button("All sessions"));
    const search = screen.getByRole("textbox", { name: "Find a session" });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "no match" } });
    expect(screen.getByText(/No sessions match/)).toBeVisible();
    fireEvent.change(search, { target: { value: "Investigation 5" } });
    fireEvent.click(button("Investigation 5"));
    expect(message()).toHaveValue("");
    expect(screen.getByText("Finished investigating")).toBeVisible();
    act(() => {
      width = 200;
      resize();
    });
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Investigation 5");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Investigation 0" })).toHaveFocus());
    expect(message()).toHaveValue("Private draft");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "End" });
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Investigation 5");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "Home" });
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Investigation 0");
    expect(harness.connections.size).toBe(6);
    for (const connection of harness.connections.values())
      expect(connection.send).not.toHaveBeenCalled();
  });

  it("renames the current session inline, returns focus, and preserves the draft through docking and details", async () => {
    await open();
    fireEvent.change(message(), { target: { value: "Keep this" } });
    fireEvent.click(button("Dock assistant"));
    expect(localStorage.getItem("optio.assistant.docked")).toBe("true");
    fireEvent.click(button("Float assistant"));
    fireEvent.click(button("Session details"));
    expect(screen.queryByRole("textbox", { name: "Message Optio" })).not.toBeInTheDocument();
    const name = screen.getByRole("textbox", { name: "Session name" });
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "Release planning" } });
    fireEvent.click(button("Save session name"));
    await screen.findByRole("tab", { name: "Release planning" });
    expect(harness.rename).toHaveBeenCalledWith("session-0", "Release planning");
    expect(message()).toHaveValue("Keep this");
    expect(message()).toHaveFocus();
    fireEvent.click(button("Session details"));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(button("Session details")).toHaveFocus());
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(message()).toHaveValue("Keep this");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useOptioChatStore.getState().isOpen).toBe(false);
  });

  it("blocks destructive controls for work or approvals, then clears and ends only the selected session", async () => {
    await open();
    const first = harness.connections.get("session-0")!;
    act(() => first.store.getState().setStatus("thinking"));
    fireEvent.click(button("Session details"));
    expect(button("Clear conversation")).toBeDisabled();
    expect(button("End session")).toBeDisabled();
    act(() => {
      first.store.getState().setStatus("ready");
      first.store.getState().addMessage({
        id: "approval",
        role: "assistant",
        content: "Review this",
        timestamp: new Date().toISOString(),
        action: { id: "action", description: "Start a task", items: [], decision: null },
      });
    });
    expect(button("End session")).toBeDisabled();
    expect(button("Clear conversation")).toBeDisabled();
    act(() => first.store.getState().resetMessages());
    fireEvent.click(button("Clear conversation"));
    expect(first.reset).toHaveBeenCalledOnce();
    await choose("Investigation 5");
    fireEvent.click(button("Session details"));
    fireEvent.click(button("End session"));
    await waitFor(() => expect(harness.end).toHaveBeenCalledWith("session-5"));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Session details" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("Investigation 0");
    expect(harness.connections.get("session-0")!.send).not.toHaveBeenCalled();
  });

  it("keeps the current conversation usable if creating a session fails, and opens a new one after recovery", async () => {
    await open();
    fireEvent.change(message(), { target: { value: "Do not lose this" } });
    harness.create.mockRejectedValueOnce(new Error("Could not start a session"));
    fireEvent.click(button("New agent session"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not start a session");
    expect(message()).toHaveValue("Do not lose this");
    fireEvent.click(button("New agent session"));
    await screen.findByRole("tab", { name: "New session" });
    expect(message()).toHaveValue("");
    fireEvent.click(button("All sessions"));
    fireEvent.click(button("Back to conversation"));
    expect(message()).toHaveFocus();
    await choose("Investigation 0");
    expect(message()).toHaveValue("Do not lose this");
  });
});
