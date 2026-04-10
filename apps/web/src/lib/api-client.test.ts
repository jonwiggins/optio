import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./api-client";

describe("api-client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    // Stub localStorage
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockResponse(data: unknown, status = 200) {
    fetchMock.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
    });
  }

  describe("listTasks", () => {
    it("fetches tasks without params", async () => {
      mockResponse({ tasks: [] });
      const result = await api.listTasks();
      expect(result).toEqual({ tasks: [] });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tasks",
        expect.objectContaining({ headers: {} }),
      );
    });

    it("appends query params when provided", async () => {
      mockResponse({ tasks: [] });
      await api.listTasks({ state: "running", limit: 10, offset: 5 });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("state=running");
      expect(url).toContain("limit=10");
      expect(url).toContain("offset=5");
    });
  });

  describe("getTask", () => {
    it("fetches a single task by id", async () => {
      const taskData = { task: { id: "abc", title: "Test" } };
      mockResponse(taskData);
      const result = await api.getTask("abc");
      expect(result).toEqual(taskData);
      expect(fetchMock).toHaveBeenCalledWith("/api/tasks/abc", expect.any(Object));
    });
  });

  describe("createTask", () => {
    it("sends POST with JSON body", async () => {
      mockResponse({ task: { id: "new-1" } });
      await api.createTask({
        title: "New Task",
        prompt: "Do something",
        repoUrl: "https://github.com/test/repo",
        agentType: "claude-code",
      });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/tasks");
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(opts.body);
      expect(body.title).toBe("New Task");
    });
  });

  describe("cancelTask", () => {
    it("sends POST to cancel endpoint", async () => {
      mockResponse({ task: { id: "abc", state: "cancelled" } });
      await api.cancelTask("abc");
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tasks/abc/cancel",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("error handling", () => {
    it("throws on non-ok response with error message", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Bad request" }),
      });
      await expect(api.getTask("abc")).rejects.toThrow("Bad request");
    });

    it("throws generic error when response has no error field", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
      await expect(api.getTask("abc")).rejects.toThrow("API error: 500");
    });

    it("handles JSON parse failure on error response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("parse failed")),
      });
      await expect(api.getTask("abc")).rejects.toThrow("API error: 500");
    });
  });

  describe("204 responses", () => {
    it("returns undefined for 204 status", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.resolve(null),
      });
      const result = await api.deleteSecret("test-secret");
      expect(result).toBeUndefined();
    });
  });

  describe("workspace header", () => {
    it("includes x-workspace-id header when set", async () => {
      (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue("ws-123");
      mockResponse({ tasks: [] });
      await api.listTasks();
      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers["x-workspace-id"]).toBe("ws-123");
    });

    it("omits x-workspace-id header when not set", async () => {
      (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(null);
      mockResponse({ tasks: [] });
      await api.listTasks();
      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers["x-workspace-id"]).toBeUndefined();
    });
  });

  describe("listWorkflows", () => {
    it("fetches workflows list", async () => {
      mockResponse({ workflows: [] });
      const result = await api.listWorkflows();
      expect(result).toEqual({ workflows: [] });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workflows",
        expect.objectContaining({ headers: {} }),
      );
    });
  });

  describe("retryTask", () => {
    it("sends POST to retry endpoint", async () => {
      mockResponse({ task: { id: "abc", state: "queued" } });
      await api.retryTask("abc");
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tasks/abc/retry",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("searchTasks", () => {
    it("builds query string from search params", async () => {
      mockResponse({ tasks: [], nextCursor: null, hasMore: false });
      await api.searchTasks({ q: "test", state: "running", limit: 20 });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("q=test");
      expect(url).toContain("state=running");
      expect(url).toContain("limit=20");
    });

    it("omits empty/null params", async () => {
      mockResponse({ tasks: [], nextCursor: null, hasMore: false });
      await api.searchTasks({ q: "", state: undefined });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toBe("/api/tasks/search");
    });
  });

  describe("exportTaskLogs", () => {
    it("returns a URL string (not a fetch call)", () => {
      const url = api.exportTaskLogs("abc", { format: "json" });
      expect(url).toBe("/api/tasks/abc/logs/export?format=json");
    });

    it("returns base URL without params", () => {
      const url = api.exportTaskLogs("abc");
      expect(url).toBe("/api/tasks/abc/logs/export");
    });
  });

  describe("bulk operations", () => {
    it("bulkRetryFailed sends POST", async () => {
      mockResponse({ retried: 3, total: 5 });
      const result = await api.bulkRetryFailed();
      expect(result).toEqual({ retried: 3, total: 5 });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tasks/bulk/retry-failed",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("bulkCancelActive sends POST", async () => {
      mockResponse({ cancelled: 2, total: 4 });
      const result = await api.bulkCancelActive();
      expect(result).toEqual({ cancelled: 2, total: 4 });
    });
  });

  describe("workflow run operations", () => {
    it("retryWorkflowRun sends POST", async () => {
      mockResponse({ run: { id: "run-1", state: "queued" } });
      const result = await api.retryWorkflowRun("run-1");
      expect(result).toEqual({ run: { id: "run-1", state: "queued" } });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workflow-runs/run-1/retry",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("cancelWorkflowRun sends POST", async () => {
      mockResponse({ run: { id: "run-1", state: "failed" } });
      const result = await api.cancelWorkflowRun("run-1");
      expect(result).toEqual({ run: { id: "run-1", state: "failed" } });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workflow-runs/run-1/cancel",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("getWorkflowRunLogs fetches logs without params", async () => {
      mockResponse({ logs: [{ content: "test" }] });
      const result = await api.getWorkflowRunLogs("run-1");
      expect(result).toEqual({ logs: [{ content: "test" }] });
      expect(fetchMock).toHaveBeenCalledWith("/api/workflow-runs/run-1/logs", expect.any(Object));
    });

    it("getWorkflowRunLogs appends query params", async () => {
      mockResponse({ logs: [] });
      await api.getWorkflowRunLogs("run-1", { limit: 100, offset: 50 });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("limit=100");
      expect(url).toContain("offset=50");
    });
  });

  // ── Workflow API methods ─────────────────────────────────────────────────

  describe("getWorkflow", () => {
    it("fetches a single workflow", async () => {
      mockResponse({ workflow: { id: "w-1", name: "Deploy" } });
      const result = await api.getWorkflow("w-1");
      expect(result.workflow.name).toBe("Deploy");
      expect(fetchMock).toHaveBeenCalledWith("/api/workflows/w-1", expect.any(Object));
    });
  });

  describe("createWorkflow", () => {
    it("sends POST with workflow data", async () => {
      mockResponse({ workflow: { id: "w-1" } });
      await api.createWorkflow({
        name: "Deploy",
        promptTemplate: "Do the thing",
      });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/workflows");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.name).toBe("Deploy");
      expect(body.promptTemplate).toBe("Do the thing");
    });
  });

  describe("updateWorkflow", () => {
    it("sends PATCH with updates", async () => {
      mockResponse({ workflow: { id: "w-1", name: "Updated" } });
      await api.updateWorkflow("w-1", { name: "Updated" });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/workflows/w-1");
      expect(opts.method).toBe("PATCH");
    });
  });

  describe("deleteWorkflow", () => {
    it("sends DELETE request", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.resolve(null),
      });
      await api.deleteWorkflow("w-1");
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workflows/w-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  describe("listWorkflowTriggers", () => {
    it("fetches triggers for a workflow", async () => {
      mockResponse({ triggers: [{ id: "t-1", type: "manual" }] });
      const result = await api.listWorkflowTriggers("w-1");
      expect(result.triggers).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledWith("/api/workflows/w-1/triggers", expect.any(Object));
    });
  });

  describe("createWorkflowTrigger", () => {
    it("sends POST with trigger data", async () => {
      mockResponse({ trigger: { id: "t-1" } });
      await api.createWorkflowTrigger("w-1", { type: "schedule" });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/workflows/w-1/triggers");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.type).toBe("schedule");
    });
  });

  describe("updateWorkflowTrigger", () => {
    it("sends PATCH with trigger updates", async () => {
      mockResponse({ trigger: { id: "t-1" } });
      await api.updateWorkflowTrigger("w-1", "t-1", { enabled: false });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/workflows/w-1/triggers/t-1");
      expect(opts.method).toBe("PATCH");
    });
  });

  describe("deleteWorkflowTrigger", () => {
    it("sends DELETE request for trigger", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.resolve(null),
      });
      await api.deleteWorkflowTrigger("w-1", "t-1");
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workflows/w-1/triggers/t-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
