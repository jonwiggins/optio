import { describe, expect, it } from "vitest";
import { builtInMcpCommand, mcpServersPreinstalled } from "./mcp-preinstalled.js";

describe("mcpServersPreinstalled", () => {
  it("is off when OPTIO_MCP_PREINSTALLED is unset: upstream's npx", () => {
    expect(mcpServersPreinstalled({})).toBe(false);
    expect(mcpServersPreinstalled({ OPTIO_MCP_PREINSTALLED: "" })).toBe(false);
  });

  it("is off whatever the model access is", () => {
    expect(mcpServersPreinstalled({ OPTIO_MODEL_ACCESS: "gateway" })).toBe(false);
  });

  it("is on with a true value, off with a false one", () => {
    for (const v of ["1", "true", "yes", "on", " TRUE "]) {
      expect(mcpServersPreinstalled({ OPTIO_MCP_PREINSTALLED: v })).toBe(true);
    }
    for (const v of ["0", "false", "no", "off"]) {
      expect(mcpServersPreinstalled({ OPTIO_MCP_PREINSTALLED: v })).toBe(false);
    }
  });
});

describe("builtInMcpCommand", () => {
  it("runs the package through npx when off", () => {
    expect(builtInMcpCommand("postgres", [], false)).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres"],
    });
    expect(builtInMcpCommand("filesystem", ["/data"], false)).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
    });
  });

  it("runs the images' binary when on", () => {
    expect(builtInMcpCommand("filesystem", ["/data"], true)).toEqual({
      command: "mcp-server-filesystem",
      args: ["/data"],
    });
  });
});
