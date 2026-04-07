import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadFileSync = vi.fn();
vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

import { parseSslConfig } from "./ssl.js";

describe("parseSslConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when sslmode is absent", () => {
    expect(parseSslConfig("postgres://u:p@host:5432/db")).toBeUndefined();
  });

  it("returns undefined for sslmode=disable", () => {
    expect(parseSslConfig("postgres://u:p@host:5432/db?sslmode=disable")).toBeUndefined();
  });

  it("returns undefined for sslmode=allow", () => {
    expect(parseSslConfig("postgres://u:p@host:5432/db?sslmode=allow")).toBeUndefined();
  });

  it("returns rejectUnauthorized=false for sslmode=require", () => {
    expect(parseSslConfig("postgres://u:p@host:5432/db?sslmode=require")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("returns rejectUnauthorized=false for sslmode=prefer", () => {
    expect(parseSslConfig("postgres://u:p@host:5432/db?sslmode=prefer")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("returns rejectUnauthorized=true for sslmode=verify-full without sslrootcert", () => {
    expect(parseSslConfig("postgres://u:p@host:5432/db?sslmode=verify-full")).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("returns rejectUnauthorized=true for sslmode=verify-ca without sslrootcert", () => {
    expect(parseSslConfig("postgres://u:p@host:5432/db?sslmode=verify-ca")).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("reads CA cert file for sslmode=verify-full with sslrootcert", () => {
    mockReadFileSync.mockReturnValue(
      "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----",
    );
    const result = parseSslConfig(
      "postgres://u:p@host:5432/db?sslmode=verify-full&sslrootcert=/etc/optio/pg-ca.crt",
    );
    expect(mockReadFileSync).toHaveBeenCalledWith("/etc/optio/pg-ca.crt", "utf-8");
    expect(result).toEqual({
      rejectUnauthorized: true,
      ca: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----",
    });
  });

  it("reads CA cert file for sslmode=verify-ca with sslrootcert", () => {
    mockReadFileSync.mockReturnValue("ca-cert-data");
    const result = parseSslConfig(
      "postgres://u:p@host:5432/db?sslmode=verify-ca&sslrootcert=/path/ca.crt",
    );
    expect(mockReadFileSync).toHaveBeenCalledWith("/path/ca.crt", "utf-8");
    expect(result).toEqual({
      rejectUnauthorized: true,
      ca: "ca-cert-data",
    });
  });

  it("returns undefined for unparseable URLs", () => {
    expect(parseSslConfig("not-a-valid-url")).toBeUndefined();
  });
});
