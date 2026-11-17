import { create } from "zustand";
import type { WorkSpec } from "@optio/shared";

/** A proposed action from Optio that needs user confirmation. */
export interface OptioPendingAction {
  id: string;
  description: string;
  items: string[];
  /** null = pending, true = approved, false = denied */
  decision: null | boolean;
  work?: WorkSpec[];
  expired?: boolean;
}

export interface OptioChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** If this message is an action proposal */
  action?: OptioPendingAction;
  /** If this is a denial feedback from user */
  isDenialFeedback?: boolean;
  isError?: boolean;
}

type OptioStatus = "ready" | "unavailable" | "starting" | "thinking" | "disconnected";

interface OptioChatState {
  /** Whether the slide-out panel is open */
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;

  /** Messages in the current ephemeral session */
  messages: OptioChatMessage[];
  addMessage: (msg: OptioChatMessage) => void;
  updateMessage: (id: string, updates: Partial<OptioChatMessage>) => void;
  resetMessages: () => void;

  /** Pre-filled input text from contextual entry points */
  prefillInput: string;
  setPrefillInput: (text: string) => void;

  /** Optio agent status */
  status: OptioStatus;
  setStatus: (status: OptioStatus) => void;

  queuedMessages: { requestId: string; content: string }[];
  setQueuedMessages: (messages: { requestId: string; content: string }[]) => void;
  agentRuntime: string | null;
  agentModel: string;
  setAgentConfiguration: (runtime: string, model: string) => void;

  /** Exchange counter (user messages sent) */
  exchangeCount: number;
  incrementExchange: () => void;
  resetExchangeCount: () => void;

  /** Max exchanges from optio settings (dynamic) */
  maxTurns: number;
  setMaxTurns: (n: number) => void;

  /** Whether write operations require confirmation */
  confirmWrites: boolean;
  setConfirmWrites: (v: boolean) => void;
}

const DEFAULT_MAX_EXCHANGES = 20;

export { DEFAULT_MAX_EXCHANGES };

export const createOptioChatStore = () =>
  create<OptioChatState>((set) => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
    toggle: () => set((s) => ({ isOpen: !s.isOpen })),

    messages: [],
    addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
    updateMessage: (id, updates) =>
      set((s) => ({
        messages: s.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
      })),
    resetMessages: () => set({ messages: [], exchangeCount: 0 }),

    prefillInput: "",
    setPrefillInput: (text) => set({ prefillInput: text }),

    status: "ready",
    setStatus: (status) => set({ status }),

    queuedMessages: [],
    setQueuedMessages: (queuedMessages) => set({ queuedMessages }),
    agentRuntime: null,
    agentModel: "",
    setAgentConfiguration: (agentRuntime, agentModel) => set({ agentRuntime, agentModel }),

    exchangeCount: 0,
    incrementExchange: () => set((s) => ({ exchangeCount: s.exchangeCount + 1 })),
    resetExchangeCount: () => set({ exchangeCount: 0 }),

    maxTurns: DEFAULT_MAX_EXCHANGES,
    setMaxTurns: (n) => set({ maxTurns: n }),

    confirmWrites: true,
    setConfirmWrites: (v) => set({ confirmWrites: v }),
  }));

export const useOptioChatStore = createOptioChatStore();
export type OptioConversationStore = ReturnType<typeof createOptioChatStore>;
