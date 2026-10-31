import { afterEach, describe, expect, it, vi } from "vitest";
import { envSmtpConfig, parseSmtpUrl } from "./smtp-config.js";

afterEach(() => vi.unstubAllEnvs());

describe("parseSmtpUrl", () => {
  it("reads smtp:// as required STARTTLS, on 587 by default", () => {
    expect(parseSmtpUrl("smtp://relay.example.com")).toEqual({
      host: "relay.example.com",
      port: 587,
      security: "starttls-required",
      username: null,
      password: null,
    });
  });

  it("requires an explicit URL option for opportunistic encryption", () => {
    expect(parseSmtpUrl("smtp://relay.example.com?starttls=optional")).toMatchObject({
      security: "starttls",
    });
  });

  it("reads smtps:// as TLS from the start, on 465", () => {
    expect(parseSmtpUrl("smtps://relay.example.com")).toMatchObject({
      port: 465,
      security: "tls",
    });
  });

  it("takes the port, the account (decoded) and the STARTTLS rule", () => {
    expect(parseSmtpUrl("smtp://optio%40corp:p%40ss%3Aword@relay:25?starttls=required")).toEqual({
      host: "relay",
      port: 25,
      security: "starttls-required",
      username: "optio@corp",
      password: "p@ss:word",
    });
    expect(parseSmtpUrl("smtp://relay:25?starttls=never")).toMatchObject({
      security: "none",
      port: 25,
    });
  });

  it("explains a wrong URL", () => {
    expect(parseSmtpUrl("relay.example.com")).toEqual({
      error: expect.stringMatching(/isn't a URL/),
    });
    expect(parseSmtpUrl("https://relay")).toEqual({
      error: "OPTIO_SMTP_URL must start with smtp:// or smtps:// (not https://)",
    });
  });
});

describe("envSmtpConfig", () => {
  it("is nothing without OPTIO_SMTP_URL", () => {
    vi.stubEnv("OPTIO_SMTP_URL", "");
    expect(envSmtpConfig()).toBeNull();
  });

  it("takes the From address, the CA and the lab switch from the environment", () => {
    vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.com:25");
    vi.stubEnv("OPTIO_SMTP_FROM", "Optio <optio@example.com>");
    vi.stubEnv("OPTIO_SMTP_CA_PEM", "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----");
    vi.stubEnv("OPTIO_SMTP_INSECURE_SKIP_VERIFY", "true");
    expect(envSmtpConfig()).toMatchObject({
      host: "relay.example.com",
      port: 25,
      from: { address: "optio@example.com", name: "Optio" },
      caPem: expect.stringContaining("BEGIN CERTIFICATE"),
      insecureSkipVerify: true,
      enabled: true,
      source: "env",
    });
  });

  it("defaults the From address to optio@ Optio's own host", () => {
    vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.com");
    vi.stubEnv("OPTIO_SMTP_FROM", "");
    vi.stubEnv("PUBLIC_URL", "https://optio.example.com");
    expect(envSmtpConfig()?.from).toEqual({ address: "optio@optio.example.com", name: "Optio" });
  });

  it("says what is missing instead of sending from nowhere", () => {
    vi.stubEnv("OPTIO_SMTP_URL", "smtp://relay.example.com");
    vi.stubEnv("OPTIO_SMTP_FROM", "");
    vi.stubEnv("PUBLIC_URL", "");
    expect(() => envSmtpConfig()).toThrow(/Set OPTIO_SMTP_FROM/);
    vi.stubEnv("OPTIO_SMTP_FROM", "nobody");
    expect(() => envSmtpConfig()).toThrow(/isn't an address: nobody/);
  });
});
