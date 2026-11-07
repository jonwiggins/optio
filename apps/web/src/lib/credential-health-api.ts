/**
 * Credential health (docs/credential-health.md): what the last check found
 * about the tokens the viewer looks after. The API is
 * routes/credential-health.ts; the shapes match its response schemas.
 */
import { request } from "@/lib/api-client";

export interface CredentialCheck {
  key: string;
  kind: "gateway" | "gitlab";
  label: string;
  scope: "person" | "organization";
  status: "ok" | "warning" | "error" | "unknown";
  reason: string | null;
  expiresAt: string | null;
  checkedAt: string;
  details: Record<string, unknown>;
}

export const credentialHealthApi = {
  list: () =>
    request<{ checks: CredentialCheck[]; intervalMinutes: number }>("/api/credential-health"),
  checkMine: () =>
    request<{ checks: CredentialCheck[] }>("/api/credential-health/me/check", {
      method: "POST",
      body: JSON.stringify({}),
    }),
};
