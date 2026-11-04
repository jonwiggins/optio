import { describe, expect, it } from "vitest";
import {
  jiraFields,
  jiraProviderConfig,
  jiraProviderSummary,
  missingJiraFields,
} from "./jira-provider-form";

const keys = (values: Parameters<typeof jiraFields>[0]) => jiraFields(values).map((f) => f.key);

describe("jira provider form", () => {
  it("shows Cloud's email + API token by default", () => {
    expect(keys({})).toEqual(["baseUrl", "email", "apiToken", "projectKey", "label"]);
    expect(jiraFields({}).find((f) => f.key === "apiToken")?.label).toBe("API token");
  });

  it("shows a username + password for Data Center basic auth", () => {
    const values = { flavor: "data-center" };
    expect(keys(values)).toEqual(["baseUrl", "username", "apiToken", "projectKey", "label"]);
    expect(jiraFields(values).find((f) => f.key === "apiToken")?.label).toBe("Password");
  });

  it("shows only the token for a Data Center personal access token", () => {
    expect(keys({ flavor: "data-center", authType: "pat" })).toEqual([
      "baseUrl",
      "apiToken",
      "projectKey",
      "label",
    ]);
  });

  it("ignores a PAT choice left over from Data Center once Cloud is picked", () => {
    expect(keys({ flavor: "cloud", authType: "pat" })).toContain("email");
  });

  it("lists the required inputs still empty", () => {
    expect(missingJiraFields({ flavor: "data-center", baseUrl: "https://jira.corp" })).toEqual([
      "Username (login)",
      "Password",
    ]);
    expect(
      missingJiraFields({ flavor: "data-center", authType: "pat", baseUrl: "x", apiToken: "p" }),
    ).toEqual([]);
  });

  it("sends Cloud configs as before: no flavor, email + token, label optio", () => {
    expect(
      jiraProviderConfig({
        baseUrl: "https://acme.atlassian.net/",
        email: " me@acme.com ",
        apiToken: "tok",
        projectKey: "",
      }),
    ).toEqual({
      baseUrl: "https://acme.atlassian.net",
      email: "me@acme.com",
      apiToken: "tok",
      label: "optio",
    });
  });

  it("sends Data Center's flavor, sign-in and only the fields it uses", () => {
    expect(
      jiraProviderConfig({
        flavor: "data-center",
        baseUrl: "https://jira.corp/jira",
        email: "typed-before-switching@corp.com",
        username: "alice",
        apiToken: " pass with spaces ",
        projectKey: "OPS",
        label: "ai-ready",
      }),
    ).toEqual({
      flavor: "data-center",
      authType: "basic",
      baseUrl: "https://jira.corp/jira",
      username: "alice",
      apiToken: " pass with spaces ",
      projectKey: "OPS",
      label: "ai-ready",
    });
    expect(
      jiraProviderConfig({
        flavor: "data-center",
        authType: "pat",
        baseUrl: "https://jira.corp",
        username: "alice",
        apiToken: "pat",
      }),
    ).toEqual({
      flavor: "data-center",
      authType: "pat",
      baseUrl: "https://jira.corp",
      apiToken: "pat",
      label: "optio",
    });
  });

  it("summarizes a saved provider", () => {
    expect(jiraProviderSummary({ baseUrl: "https://acme.atlassian.net" })).toBe(
      "https://acme.atlassian.net",
    );
    expect(jiraProviderSummary({ baseUrl: "https://jira.corp", flavor: "data-center" })).toBe(
      "https://jira.corp · Data Center",
    );
    expect(jiraProviderSummary(undefined)).toBe("");
  });
});
