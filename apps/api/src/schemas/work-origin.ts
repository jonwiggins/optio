import { z } from "zod";

export const WorkOriginSchema = z.object({
  spawnedBy: z.string(),
  triggerType: z.string().nullable().optional(),
  ticketSource: z.string().nullable().optional(),
});
