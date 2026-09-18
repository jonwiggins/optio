/**
 * Shared markdown assembly for ticket/issue context injected into agent
 * prompts. Used by ticket-sync, the Issues assign route, and Optio Local
 * ticket spawns — keep the format identical across all three.
 */

export interface TicketCommentLike {
  author: string;
  createdAt: string;
  body: string;
}

export function buildCommentsSection(comments: TicketCommentLike[]): string {
  if (comments.length === 0) return "";
  return (
    "\n\n## Comments\n\n" +
    comments.map((c) => `**${c.author}** (${c.createdAt}):\n${c.body}`).join("\n\n")
  );
}

export function buildTicketPrompt(input: {
  title: string;
  body?: string | null;
  comments?: TicketCommentLike[];
}): string {
  return `${input.title}\n\n${input.body ?? ""}${buildCommentsSection(input.comments ?? [])}`;
}
