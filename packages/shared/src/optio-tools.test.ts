import { describe, it, expect } from "vitest";
import {
  OPTIO_TOOLS,
  getOptioToolDefinitions,
  getOptioToolsByCategory,
  toFunctionCallingFormat,
  WATCH_TERMINAL_STATES,
  LOG_ENTRY_MAX_LENGTH,
} from "./optio-tools.js";

describe("OPTIO_TOOLS", () => {
  it("contains 18 tool definitions", () => {
    expect(Object.keys(OPTIO_TOOLS)).toHaveLength(18);
  });

  it("has unique tool names", () => {
    const names = Object.keys(OPTIO_TOOLS);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tools have required fields", () => {
    for (const [name, tool] of Object.entries(OPTIO_TOOLS)) {
      expect(tool.name, `${name} should have name`).toBe(name);
      expect(tool.description, `${name} should have description`).toBeTruthy();
      expect(tool.category, `${name} should have category`).toBeTruthy();
      expect(tool.parameters.type, `${name} should have object params`).toBe("object");
      expect(tool.endpoint.method, `${name} should have method`).toBeTruthy();
      expect(tool.endpoint.path, `${name} should have path`).toBeTruthy();
    }
  });

  it("all endpoints have valid HTTP methods", () => {
    const validMethods = new Set(["GET", "POST", "PATCH", "DELETE"]);
    for (const tool of Object.values(OPTIO_TOOLS)) {
      expect(validMethods.has(tool.endpoint.method), `${tool.name}: ${tool.endpoint.method}`).toBe(
        true,
      );
    }
  });

  it("all endpoint paths start with /api/", () => {
    for (const tool of Object.values(OPTIO_TOOLS)) {
      expect(tool.endpoint.path.startsWith("/api/"), `${tool.name}: ${tool.endpoint.path}`).toBe(
        true,
      );
    }
  });

  it("tools with required parameters list them correctly", () => {
    const toolsWithRequired = Object.values(OPTIO_TOOLS).filter(
      (t) => t.parameters.required && t.parameters.required.length > 0,
    );
    for (const tool of toolsWithRequired) {
      for (const req of tool.parameters.required!) {
        expect(
          tool.parameters.properties[req],
          `${tool.name}: required param "${req}" missing from properties`,
        ).toBeDefined();
      }
    }
  });

  it("only watch_task is a polling tool", () => {
    const pollingTools = Object.values(OPTIO_TOOLS).filter((t) => t.isPolling);
    expect(pollingTools).toHaveLength(1);
    expect(pollingTools[0].name).toBe("watch_task");
  });
});

describe("getOptioToolDefinitions", () => {
  it("returns all tools as an array", () => {
    const tools = getOptioToolDefinitions();
    expect(tools).toHaveLength(18);
    expect(Array.isArray(tools)).toBe(true);
  });
});

describe("getOptioToolsByCategory", () => {
  it("returns tasks category tools", () => {
    const taskTools = getOptioToolsByCategory("tasks");
    expect(taskTools.length).toBeGreaterThanOrEqual(7);
    expect(taskTools.every((t) => t.category === "tasks")).toBe(true);
  });

  it("returns repos category tools", () => {
    const repoTools = getOptioToolsByCategory("repos");
    expect(repoTools).toHaveLength(3);
    expect(repoTools.every((t) => t.category === "repos")).toBe(true);
  });

  it("returns issues category tools", () => {
    const issueTools = getOptioToolsByCategory("issues");
    expect(issueTools).toHaveLength(2);
    expect(issueTools.every((t) => t.category === "issues")).toBe(true);
  });

  it("returns pods category tools", () => {
    const podTools = getOptioToolsByCategory("pods");
    expect(podTools).toHaveLength(2);
  });

  it("returns system category tools", () => {
    const systemTools = getOptioToolsByCategory("system");
    expect(systemTools).toHaveLength(1);
    expect(systemTools[0].name).toBe("get_system_status");
  });

  it("returns watch category tools", () => {
    const watchTools = getOptioToolsByCategory("watch");
    expect(watchTools).toHaveLength(1);
    expect(watchTools[0].name).toBe("watch_task");
  });

  it("returns costs category tools", () => {
    const costTools = getOptioToolsByCategory("costs");
    expect(costTools).toHaveLength(1);
    expect(costTools[0].name).toBe("get_cost_analytics");
  });
});

describe("toFunctionCallingFormat", () => {
  it("strips Optio-specific fields", () => {
    const tools = getOptioToolDefinitions();
    const formatted = toFunctionCallingFormat(tools);

    for (const tool of formatted) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("parameters");
      // Should NOT have Optio-specific fields
      expect(tool).not.toHaveProperty("endpoint");
      expect(tool).not.toHaveProperty("isPolling");
      expect(tool).not.toHaveProperty("category");
    }
  });

  it("preserves tool names and descriptions", () => {
    const tools = getOptioToolDefinitions();
    const formatted = toFunctionCallingFormat(tools);

    for (let i = 0; i < tools.length; i++) {
      expect(formatted[i].name).toBe(tools[i].name);
      expect(formatted[i].description).toBe(tools[i].description);
    }
  });

  it("preserves parameter schemas", () => {
    const formatted = toFunctionCallingFormat([OPTIO_TOOLS.create_task]);
    expect(formatted[0].parameters.required).toContain("title");
    expect(formatted[0].parameters.required).toContain("prompt");
    expect(formatted[0].parameters.properties.priority).toBeDefined();
  });
});

describe("constants", () => {
  it("WATCH_TERMINAL_STATES contains expected states", () => {
    expect(WATCH_TERMINAL_STATES.has("completed")).toBe(true);
    expect(WATCH_TERMINAL_STATES.has("failed")).toBe(true);
    expect(WATCH_TERMINAL_STATES.has("cancelled")).toBe(true);
    expect(WATCH_TERMINAL_STATES.has("pr_opened")).toBe(true);
    expect(WATCH_TERMINAL_STATES.has("running")).toBe(false);
    expect(WATCH_TERMINAL_STATES.has("queued")).toBe(false);
  });

  it("LOG_ENTRY_MAX_LENGTH is a reasonable value", () => {
    expect(LOG_ENTRY_MAX_LENGTH).toBeGreaterThan(0);
    expect(LOG_ENTRY_MAX_LENGTH).toBeLessThanOrEqual(10000);
  });
});

describe("tool schema validation", () => {
  it("get_task_logs has tail parameter with correct defaults", () => {
    const tool = OPTIO_TOOLS.get_task_logs;
    expect(tool.parameters.properties.tail).toBeDefined();
    expect(tool.parameters.properties.tail.default).toBe(100);
    expect(tool.parameters.properties.tail.type).toBe("number");
  });

  it("create_task has all required params", () => {
    const tool = OPTIO_TOOLS.create_task;
    expect(tool.parameters.required).toEqual(
      expect.arrayContaining(["title", "prompt", "repoUrl", "agentType"]),
    );
  });

  it("watch_task has timeout and poll interval defaults", () => {
    const tool = OPTIO_TOOLS.watch_task;
    expect(tool.parameters.properties.timeoutSeconds.default).toBe(600);
    expect(tool.parameters.properties.pollIntervalSeconds.default).toBe(10);
  });

  it("list_tasks state enum matches TaskState values", () => {
    const tool = OPTIO_TOOLS.list_tasks;
    const stateEnum = tool.parameters.properties.state.enum!;
    expect(stateEnum).toContain("running");
    expect(stateEnum).toContain("failed");
    expect(stateEnum).toContain("completed");
    expect(stateEnum).toContain("queued");
    expect(stateEnum).toContain("pr_opened");
    expect(stateEnum).toContain("pending");
  });

  it("get_system_status targets the correct endpoint", () => {
    const tool = OPTIO_TOOLS.get_system_status;
    expect(tool.endpoint.method).toBe("GET");
    expect(tool.endpoint.path).toBe("/api/optio/system-status");
  });
});
