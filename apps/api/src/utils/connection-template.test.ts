import { describe, expect, it } from "vitest";
import {
  connectionSlug,
  isOnlyPlaceholders,
  parseArgLines,
  parseEnvLines,
  renderEnvTemplates,
  renderTemplate,
} from "./connection-template.js";

const lookup = (values: Record<string, string>) => (key: string) => values[key];

describe("renderTemplate", () => {
  it("fills {{key}} placeholders, tolerating spaces, and renders unknown keys empty", () => {
    const l = lookup({ HOST: "api.example.com", TOKEN: "t1" });
    expect(renderTemplate("https://{{HOST}}/me", l)).toBe("https://api.example.com/me");
    expect(renderTemplate("Bearer {{ TOKEN }}", l)).toBe("Bearer t1");
    expect(renderTemplate("{{MISSING}}", l)).toBe("");
    expect(renderTemplate("plain", l)).toBe("plain");
  });

  it("knows a template that is only placeholders", () => {
    expect(isOnlyPlaceholders("{{A}}")).toBe(true);
    expect(isOnlyPlaceholders(" {{A}} {{B}} ")).toBe(true);
    expect(isOnlyPlaceholders("Bearer {{A}}")).toBe(false);
  });
});

describe("renderEnvTemplates", () => {
  it("drops a var whose template is only placeholders that rendered empty", () => {
    const env = renderEnvTemplates(
      {
        AWS_ACCESS_KEY_ID: "{{AWS_ACCESS_KEY_ID}}",
        AWS_REGION: "{{AWS_REGION}}",
        OPTIO_HTTP_AUTH_VALUE: "Bearer {{TOKEN}}",
        STATIC: "x",
      },
      lookup({ AWS_REGION: "us-east-1" }),
    );
    expect(env).toEqual({ AWS_REGION: "us-east-1", OPTIO_HTTP_AUTH_VALUE: "Bearer ", STATIC: "x" });
  });
});

describe("custom MCP fields", () => {
  it("parses KEY=VALUE lines, skipping comments, blanks, and bad names", () => {
    expect(parseEnvLines("A=1\n# c\n\nB = two=2\n9X=no\nnoeq\n")).toEqual({ A: "1", B: "two=2" });
    expect(parseEnvLines(undefined)).toEqual({});
  });

  it("splits args by line", () => {
    expect(parseArgLines(" -y \n@scope/pkg\n\n")).toEqual(["-y", "@scope/pkg"]);
  });
});

describe("connectionSlug", () => {
  it("makes a file-safe slug", () => {
    expect(connectionSlug("Jon's AWS")).toBe("jon-s-aws");
    expect(connectionSlug("  Acme / Linear  ")).toBe("acme-linear");
    expect(connectionSlug("___")).toBe("connection");
  });
});
