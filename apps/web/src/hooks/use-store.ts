import { create } from "zustand";

export interface TaskSummary {
  id: string;
  title: string;
  state: string;
  agentType: string;
  repoUrl: string;
  prUrl?: string;
  costUsd?: string;
  errorMessage?: string;
  taskType?: string;
  parentTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

interface AppState {
  tasks: TaskSummary[];
  setTasks: (tasks: TaskSummary[]) => void;
  updateTask: (id: string, updates: Partial<TaskSummary>) => void;
  addTask: (task: TaskSummary) => void;
  notifications: Notification[];
  addNotification: (n: Notification) => void;
  dismissNotification: (id: string) => void;
}

export interface Notification {
  id: string;
  type: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
  taskId?: string;
  timestamp: string;
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
}));
