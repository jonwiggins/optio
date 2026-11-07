/**
 * The ticket round trip on a ticket provider (docs/ticket-round-trip.md):
 * its settings, the statuses to map to, and the Test button. The API is
 * apps/api/src/routes/ticket-round-trip.ts; who may call it is whoever may
 * change the provider.
 */
import type { RoundTripStep, TicketRoundTripSettings } from "@optio/shared";
import { request } from "@/lib/api-client";

export interface TicketStatusOption {
  name: string;
  category?: string;
}

export interface RoundTripCheck {
  ok: boolean;
  error?: string;
  issueKey: string;
  status?: string | null;
  available?: string[];
  steps?: Array<{ step: RoundTripStep; status: string; outcome: "ready" | "here" | "unreachable" }>;
}

const base = (id: string) => `/api/tickets/providers/${encodeURIComponent(id)}`;

export const ticketRoundTripApi = {
  save: (id: string, roundTrip: TicketRoundTripSettings) =>
    request<{ roundTrip: TicketRoundTripSettings }>(`${base(id)}/round-trip`, {
      method: "PUT",
      body: JSON.stringify(roundTrip),
    }),
  statuses: (id: string) =>
    request<{ statuses: TicketStatusOption[]; scope: string }>(`${base(id)}/round-trip/statuses`),
  /** Tests `transitions` (the form's) or, without them, the saved mapping. */
  check: (id: string, issueKey: string, transitions?: TicketRoundTripSettings["transitions"]) =>
    request<RoundTripCheck>(`${base(id)}/round-trip/check`, {
      method: "POST",
      body: JSON.stringify({ issueKey, ...(transitions ? { transitions } : {}) }),
    }),
};
