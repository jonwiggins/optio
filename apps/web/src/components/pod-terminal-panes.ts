/** Pane arrangement belongs to this URL/view, never to the session record. */
export type PodTerminalPane = "1" | "2";
export function parsePodTerminals(params: { get(name: string): string | null }): PodTerminalPane[] {
  return [...new Set((params.get("terminals") ?? "").split(","))].filter(
    (id): id is PodTerminalPane => id === "1" || id === "2",
  );
}
export function podTerminalsHref(id: string, panes: PodTerminalPane[]): string {
  const query = new URLSearchParams();
  if (panes.length) query.set("terminals", panes.join(","));
  return `/sessions/${id}${query.size ? `?${query}` : ""}`;
}
