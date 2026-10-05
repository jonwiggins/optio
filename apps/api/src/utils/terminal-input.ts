/**
 * A message typed into a chat composer arrives as one chunk, `text\r`. An
 * agent TUI that detects pastes by key timing (Codex: keys closer than
 * ~8 ms are a burst, and an Enter within 120 ms of the burst is a newline,
 * not a submit) then inserts the newline and never sends the message. Sent
 * as two writes a beat apart, the Enter is a keypress again. A bare Enter,
 * or text without one, is written as is.
 */
export const SUBMIT_GAP_MS = 250;

/** The writes a chunk of terminal input becomes, in order. */
export function splitSubmit(data: string): string[] {
  const m = /^([\s\S]*[^\r\n])(\r\n|\r|\n)$/.exec(data);
  return m ? [m[1]!, m[2]!] : [data];
}
