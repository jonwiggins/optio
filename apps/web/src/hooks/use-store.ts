import { create } from "zustand";

export interface TaskSummary {
  id: string;
  title: string;
  state: string;
  agentType: string;
  repoUrl: string;
  prUrl?: string;
  prChecksStatus?: string;
  prReviewStatus?: string;
  costUsd?: string;
  errorMessage?: string;
  taskType?: string;
  parentTaskId?: string;
  ticketExternalId?: string;
  pendingReason?: string | null;
  lastActivityAt?: string;
  activitySubstate?: string;
  isStalled?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface AppState {
  tasks: TaskSummary[];
  setTasks: (tasks: TaskSummary[]) => void;
  updateTask: (id: string, updates: Partial<TaskSummary>) => void;
  addTask: (task: TaskSummary) => void;
  notifications: Notification[];
  addNotification: (n: Notification) => void;
  dismissNotification: (id: string) => void;
  // Workspace state
  currentWorkspaceId: string | null;
  workspaces: WorkspaceSummary[];
  setCurrentWorkspace: (id: string) => void;
  setWorkspaces: (workspaces: WorkspaceSummary[]) => void;
}

export interface Notification {
  id: string;
  type: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
  taskId?: string;
  timestamp: string;
}

// Load persisted workspace ID from localStorage
function getPersistedWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem("optio_workspace_id");
  } catch {
    return null;
  }
}

export const useStore = create<AppState>((set) => ({
  tasks: [],
  setTasks: (tasks) => set({ tasks }),
  updateTask: (id, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),
  addTask: (task) =>
    set((state) => ({
      tasks: [task, ...state.tasks],
    })),

  notifications: [],
  addNotification: (n) =>
    set((state) => ({
      notifications: [n, ...state.notifications].slice(0, 50),
    })),
  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),

  // Workspace state
  currentWorkspaceId: getPersistedWorkspaceId(),
  workspaces: [],
  setCurrentWorkspace: (id) => {
    try {
      localStorage.setItem("optio_workspace_id", id);
    } catch {}
    set({ currentWorkspaceId: id });
  },
  setWorkspaces: (workspaces) => set({ workspaces }),
}));
