import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseIntEnv } from "./parse-int-env.js";

describe("parseIntEnv", () => {
  const ENV_KEY = "TEST_PARSE_INT_ENV";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
  });

  it("returns the parsed value when env var is a valid integer", () => {
    process.env[ENV_KEY] = "42";
    expect(parseIntEnv(ENV_KEY, 100)).toBe(42);
  });

  it("returns the default when env var is undefined", () => {
    delete process.env[ENV_KEY];
    expect(parseIntEnv(ENV_KEY, 100)).toBe(100);
  });

  it("returns the default when env var is empty string", () => {
    process.env[ENV_KEY] = "";
    expect(parseIntEnv(ENV_KEY, 100)).toBe(100);
  });

  it("returns the default when env var is whitespace only", () => {
    process.env[ENV_KEY] = "   ";
    expect(parseIntEnv(ENV_KEY, 100)).toBe(100);
  });

  it("parses values with leading/trailing whitespace", () => {
    process.env[ENV_KEY] = "  50  ";
    expect(parseIntEnv(ENV_KEY, 100)).toBe(50);
  });

  it("returns NaN for non-numeric strings (caller validates)", () => {
    process.env[ENV_KEY] = "abc";
    expect(parseIntEnv(ENV_KEY, 100)).toBeNaN();
  });

  it("parses negative integers", () => {
    process.env[ENV_KEY] = "-10";
    expect(parseIntEnv(ENV_KEY, 100)).toBe(-10);
  });

  it("parses zero", () => {
    process.env[ENV_KEY] = "0";
    expect(parseIntEnv(ENV_KEY, 100)).toBe(0);
  });

  it("truncates decimal values (parseInt behavior)", () => {
    process.env[ENV_KEY] = "3.14";
    expect(parseIntEnv(ENV_KEY, 100)).toBe(3);
  });
});
