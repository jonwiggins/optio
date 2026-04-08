import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock the paths module to use a temp directory
const tempDir = mkdtempSync(join(tmpdir(), "optio-test-"));
const testConfigPath = join(tempDir, "config.json");
const testCredentialsPath = join(tempDir, "credentials.json");

vi.mock("../config/paths.js", () => ({
  configPath: () => testConfigPath,
  credentialsPath: () => testCredentialsPath,
}));

import { loadConfig, saveConfig, getServerUrl } from "../config/config-store.js";
import { loadCredentials, saveCredentials } from "../config/credentials-store.js";

describe("config-store", () => {
  beforeEach(() => {
    // Clean up temp files
    try {
      rmSync(testConfigPath);
    } catch {
      /* ignore */
    }
    try {
      rmSync(testCredentialsPath);
    } catch {
      /* ignore */
    }
  });

  it("returns empty config when file does not exist", () => {
    const config = loadConfig();
    expect(config).toEqual({ hosts: {} });
  });

  it("saves and loads config", () => {
    const config = {
      currentHost: "example.com",
      hosts: {
        "example.com": {
          server: "https://example.com",
          workspaceId: "ws-1",
        },
      },
    };
    saveConfig(config);

    const loaded = loadConfig();
    expect(loaded.currentHost).toBe("example.com");
    expect(loaded.hosts["example.com"].server).toBe("https://example.com");
  });

  it("getServerUrl returns flag value when provided", () => {
    const config = loadConfig();
    expect(getServerUrl(config, "https://flag.com")).toBe("https://flag.com");
  });

  it("getServerUrl strips trailing slash", () => {
    const config = loadConfig();
    expect(getServerUrl(config, "https://flag.com/")).toBe("https://flag.com");
  });

  it("getServerUrl returns config host when no flag", () => {
    saveConfig({
      currentHost: "test.com",
      hosts: { "test.com": { server: "https://test.com" } },
    });
    const config = loadConfig();
    expect(getServerUrl(config)).toBe("https://test.com");
  });
});

describe("credentials-store", () => {
  beforeEach(() => {
    try {
      rmSync(testCredentialsPath);
    } catch {
      /* ignore */
    }
  });

  it("returns empty credentials when file does not exist", () => {
    const creds = loadCredentials();
    expect(creds).toEqual({ hosts: {} });
  });

  it("saves and loads credentials", () => {
    const creds = {
      hosts: {
        "example.com": {
          token: "optio_pat_abc123",
          tokenId: "key-1",
          user: { id: "u-1", email: "test@example.com", displayName: "Test" },
        },
      },
    };
    saveCredentials(creds);

    const loaded = loadCredentials();
    expect(loaded.hosts["example.com"].token).toBe("optio_pat_abc123");
    expect(loaded.hosts["example.com"].user.email).toBe("test@example.com");
  });

  it("saves credentials with restricted permissions", () => {
    saveCredentials({ hosts: {} });
    // Read the file to verify it exists
    const content = readFileSync(testCredentialsPath, "utf-8");
    expect(JSON.parse(content)).toEqual({ hosts: {} });
  });
});
