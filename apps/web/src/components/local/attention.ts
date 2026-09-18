/**
 * Pure helpers behind the Local attention indicators (favicon dot, title
 * badge, bell notifications). Kept free of DOM so they can be unit tested.
 */

export type AttentionTone = "needs_you" | "working" | "idle";

export interface AttentionSummary {
  tone: AttentionTone;
  needsYou: number;
  working: number;
}

function isLive(t: any): boolean {
  return t.state === "running" || t.state === "launching";
}

/** Roll every terminal up into one color: yellow beats green beats grey. */
export function summarizeAttention(terminals: any[]): AttentionSummary {
  const needsYou = terminals.filter((t) => t.attentionState === "needs_you").length;
  const working = terminals.filter((t) => isLive(t) && t.attentionState === "working").length;
  return {
    tone: needsYou > 0 ? "needs_you" : working > 0 ? "working" : "idle",
    needsYou,
    working,
  };
}

export const TONE_COLOR: Record<AttentionTone, string> = {
  needs_you: "#f0a040",
  working: "#34d399",
  idle: "#807c88",
};

/** The Optio bolt favicon with a status dot in the corner. */
export function faviconSvg(tone: AttentionTone): string {
  const dot = TONE_COLOR[tone];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="6" fill="#6d28d9"/>` +
    `<path d="M8 18.5a.67.67 0 0 1-.52-1.09l6.6-6.8a.33.33 0 0 1 .57.31l-1.28 4.01A.67.67 0 0 0 14 16h4.67a.67.67 0 0 1 .52 1.09l-6.6 6.8a.33.33 0 0 1-.57-.31l1.28-4.01A.67.67 0 0 0 12.67 18.5H8z" fill="white"/>` +
    // Dark ring so the dot reads on the purple tile at 16px.
    `<circle cx="25" cy="25" r="7.5" fill="#0d0d11"/>` +
    `<circle cx="25" cy="25" r="5.5" fill="${dot}"/>` +
    `</svg>`
  );
}

export function faviconDataUrl(tone: AttentionTone): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(tone))}`;
}

/** Ids of armed terminals that just flipped into "needs you". */
export function ringingBells(
  prev: Map<string, string>,
  terminals: any[],
  armed: Iterable<string>,
): any[] {
  const armedSet = new Set(armed);
  return terminals.filter((t) => {
    if (!armedSet.has(t.id)) return false;
    if (t.attentionState !== "needs_you") return false;
    const before = prev.get(t.id);
    // Unknown before (first load) counts as "already ringing" — don't
    // re-notify on every page open.
    return before !== undefined && before !== "needs_you";
  });
}
