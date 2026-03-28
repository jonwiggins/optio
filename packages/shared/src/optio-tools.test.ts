import { describe, it, expect } from "vitest";
import {
  OPTIO_TOOL_SCHEMAS,
  OPTIO_TOOL_MAP,
  OPTIO_TOOL_NAMES,
  getToolsByCategory,
  getEnabledToolSchemas,
  TERMINAL_TASK_STATES,
  LOG_ENTRY_MAX_LENGTH,
  LOG_TAIL_DEFAULT,
} from "./optio-tools.js";

describe("OPTIO_TOOL_SCHEMAS", () => {
  it("contains 18 tool definitions", () => {
    expect(OPTIO_TOOL_SCHEMAS).toHaveLength(18);
  });

  it("every tool has required fields", () => {
    for (const tool of OPTIO_TOOL_SCHEMAS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.category).toBeTruthy();
      expect(tool.endpoint).toBeTruthy();
      expect(["GET", "POST", "PATCH", "DELETE"]).toContain(tool.method);
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema.properties).toBeDefined();
    }
  });

  it("tool names are unique", () => {
    const names = OPTIO_TOOL_SCHEMAS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool with required fields has those fields in properties", () => {
    for (const tool of OPTIO_TOOL_SCHEMAS) {
      if (tool.input_schema.required) {
        for (const req of tool.input_schema.required) {
          expect(tool.input_schema.properties).toHaveProperty(req);
        }
      }
    }
  });
});

describe("OPTIO_TOOL_MAP", () => {
  it("has an entry for every tool", () => {
    expect(Object.keys(OPTIO_TOOL_MAP)).toHaveLength(OPTIO_TOOL_SCHEMAS.length);
  });

  it("maps name to the correct tool", () => {
    expect(OPTIO_TOOL_MAP["list_tasks"].endpoint).toBe("GET /api/tasks");
    expect(OPTIO_TOOL_MAP["create_task"].method).toBe("POST");
    expect(OPTIO_TOOL_MAP["get_system_status"].endpoint).toBe("GET /api/optio/system-status");
  });
});

describe("OPTIO_TOOL_NAMES", () => {
  it("matches schema names", () => {
    expect(OPTIO_TOOL_NAMES).toEqual(OPTIO_TOOL_SCHEMAS.map((t) => t.name));
  });
});

describe("getToolsByCategory", () => {
  it("groups tools by category", () => {
    const grouped = getToolsByCategory();
    expect(grouped["Tasks"]).toBeDefined();
    expect(grouped["Repos"]).toBeDefined();
    expect(grouped["Issues"]).toBeDefined();
    expect(grouped["Pods"]).toBeDefined();
    expect(grouped["Costs"]).toBeDefined();
    expect(grouped["System"]).toBeDefined();
  });

  it("Tasks category has 9 tools (including watch_task)", () => {
    const grouped = getToolsByCategory();
    expect(grouped["Tasks"]).toHaveLength(9);
  });

  it("Repos category has 3 tools", () => {
    const grouped = getToolsByCategory();
    expect(grouped["Repos"]).toHaveLength(3);
  });
});

describe("getEnabledToolSchemas", () => {
  it("filters to only enabled tools", () => {
    const enabled = getEnabledToolSchemas(["list_tasks", "create_task"]);
    expect(enabled).toHaveLength(2);
    expect(enabled.map((t) => t.name)).toEqual(["list_tasks", "create_task"]);
  });

  it("returns empty array for no matches", () => {
    const enabled = getEnabledToolSchemas(["nonexistent_tool"]);
    expect(enabled).toHaveLength(0);
  });

  it("returns all tools when all names provided", () => {
    const enabled = getEnabledToolSchemas(OPTIO_TOOL_NAMES);
    expect(enabled).toHaveLength(OPTIO_TOOL_SCHEMAS.length);
  });
});

describe("constants", () => {
  it("TERMINAL_TASK_STATES contains expected values", () => {
    expect(TERMINAL_TASK_STATES).toEqual(["completed", "failed", "cancelled"]);
  });

  it("LOG_ENTRY_MAX_LENGTH is 2000", () => {
    expect(LOG_ENTRY_MAX_LENGTH).toBe(2000);
  });

  it("LOG_TAIL_DEFAULT is 100", () => {
    expect(LOG_TAIL_DEFAULT).toBe(100);
  });
});

describe("tool schema compatibility", () => {
  it("all schemas have valid JSON Schema input_schema", () => {
    for (const tool of OPTIO_TOOL_SCHEMAS) {
      // Claude function calling requires type: "object" at top level
      expect(tool.input_schema.type).toBe("object");
      // Properties must be an object
      expect(typeof tool.input_schema.properties).toBe("object");
    }
  });

  it("watch_task has polling parameters", () => {
    const watch = OPTIO_TOOL_MAP["watch_task"];
    expect(watch.input_schema.properties).toHaveProperty("pollIntervalSeconds");
    expect(watch.input_schema.properties).toHaveProperty("timeoutMinutes");
    expect(watch.input_schema.required).toContain("id");
  });

  it("get_task_logs has tail and logType parameters", () => {
    const logs = OPTIO_TOOL_MAP["get_task_logs"];
    expect(logs.input_schema.properties).toHaveProperty("tail");
    expect(logs.input_schema.properties).toHaveProperty("logType");
    expect(logs.input_schema.properties.logType.enum).toBeDefined();
  });
});
