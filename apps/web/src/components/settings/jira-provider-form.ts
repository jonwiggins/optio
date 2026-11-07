/**
 * The Jira ticket provider's form, shared by Settings → Integrations →
 * Tickets and the setup wizard. Atlassian Cloud signs in with an email + API
 * token; a self-hosted Data Center (or Server) node with a username +
 * password or a personal access token, so the fields follow the flavor and
 * the sign-in choice. The credential is always sent as `apiToken`, the one
 * field the API stores encrypted.
 */

export type JiraFlavor = "cloud" | "data-center";
export type JiraAuthType = "basic" | "pat";

export const JIRA_FLAVOR_OPTIONS: { value: JiraFlavor; label: string }[] = [
  { value: "cloud", label: "Cloud" },
  { value: "data-center", label: "Data Center / Server" },
];

export const JIRA_AUTH_OPTIONS: { value: JiraAuthType; label: string }[] = [
  { value: "basic", label: "Username + password" },
  { value: "pat", label: "Personal access token" },
];

export interface JiraField {
  key: "baseUrl" | "email" | "username" | "apiToken" | "projectKey" | "label";
  label: string;
  type?: "password";
  placeholder?: string;
  required: boolean;
}

/** The form's values as typed (every input is a string). */
export type JiraFormValues = Partial<Record<JiraField["key"] | "flavor" | "authType", string>>;

export function jiraFlavor(values: JiraFormValues): JiraFlavor {
  return values.flavor === "data-center" ? "data-center" : "cloud";
}

export function jiraAuthType(values: JiraFormValues): JiraAuthType {
  return jiraFlavor(values) === "data-center" && values.authType === "pat" ? "pat" : "basic";
}

/** The inputs to show, in order, for the chosen flavor and sign-in. */
export function jiraFields(values: JiraFormValues): JiraField[] {
  const flavor = jiraFlavor(values);
  const auth = jiraAuthType(values);
  const fields: JiraField[] = [
    {
      key: "baseUrl",
      label: "Jira URL",
      placeholder:
        flavor === "cloud" ? "https://company.atlassian.net" : "https://jira.company.com",
      required: true,
    },
  ];
  if (flavor === "cloud") {
    fields.push(
      { key: "email", label: "Account email", placeholder: "you@company.com", required: true },
      { key: "apiToken", label: "API token", type: "password", required: true },
    );
  } else if (auth === "basic") {
    fields.push(
      { key: "username", label: "Username (login)", placeholder: "jdoe", required: true },
      { key: "apiToken", label: "Password", type: "password", required: true },
    );
  } else {
    fields.push({
      key: "apiToken",
      label: "Personal access token",
      type: "password",
      required: true,
    });
  }
  fields.push(
    { key: "projectKey", label: "Project key (optional)", placeholder: "ENG", required: false },
    { key: "label", label: "Label to sync (default optio)", placeholder: "optio", required: false },
  );
  return fields;
}

/** The required inputs still empty, by label; empty means the form can be saved. */
export function missingJiraFields(values: JiraFormValues): string[] {
  return jiraFields(values)
    .filter((f) => f.required && !values[f.key]?.trim())
    .map((f) => f.label);
}

/**
 * The provider config to POST: only the fields the flavor uses (a value typed
 * before switching flavor is not sent), trimmed, empty ones left out, and the
 * label defaulting to `optio`. The secret is not trimmed.
 */
export function jiraProviderConfig(values: JiraFormValues): Record<string, string> {
  const flavor = jiraFlavor(values);
  const config: Record<string, string> = { label: "optio" };
  if (flavor === "data-center") {
    config.flavor = flavor;
    config.authType = jiraAuthType(values);
  }
  for (const field of jiraFields(values)) {
    const raw = values[field.key];
    const value = field.key === "apiToken" ? raw : raw?.trim();
    if (!value) continue;
    config[field.key] = field.key === "baseUrl" ? value.replace(/\/+$/, "") : value;
  }
  return config;
}

/** A saved provider's one-line summary in the list. */
export function jiraProviderSummary(config: { baseUrl?: string; flavor?: string } | undefined) {
  if (!config?.baseUrl) return "";
  return config.flavor === "data-center" ? `${config.baseUrl} · Data Center` : config.baseUrl;
}
