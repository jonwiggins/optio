/**
 * OSC 7501 — the Program Status Protocol (revision 0.4,
 * https://control-codes.page/proposals/osc-7501/; Ghostty 1.4 parses it,
 * Claude Code, Pi and Crush emit it).
 *
 * A program tells its terminal what it is up to instead of the terminal
 * guessing from the bytes: `OSC 7501 ; state=blocked : kind=permission :
 * msg=<base64> ST`. The daemon's screen model is the terminal the program
 * talks to (see `ScreenModel`), so it answers the capability query
 * (`OSC 7501 ; ? ST`) — Claude Code only reports once something answered —
 * and hands each report to the attention tracker, where it outranks hooks,
 * bells and silence.
 *
 * Reports are untrusted program output: every value is checked against the
 * spec's alphabet and limits, `msg` / `title` are base64 that must not decode
 * to a control character, and a report that breaks a limit is dropped whole.
 */

const PROGRAM_STATUS_STATES = ["idle", "working", "done", "blocked", "error"] as const;
type ProgramStatusState = (typeof PROGRAM_STATUS_STATES)[number];

const PROGRAM_STATUS_KINDS = ["permission", "question", "auth"] as const;
type ProgramStatusKind = (typeof PROGRAM_STATUS_KINDS)[number];

export interface ProgramStatusReport {
  /** `clear` removes the record (and its descendants; every record without an id). */
  state: ProgramStatusState | "clear";
  /** Record path (`a/b`); null is the root record. */
  id: string | null;
  /** Why a `blocked` program is blocked (null = unspecified). */
  kind: ProgramStatusKind | null;
  /** 0–100 for `working` / `blocked`; null = indeterminate. */
  progress: number | null;
  /** The program's stable name (`claude`). */
  app: string | null;
  /** Short label (decoded). */
  title: string | null;
  /** One line about what it is doing or waiting for (decoded). */
  msg: string | null;
}

/** What the terminal answers to `OSC 7501 ; ?` (ST-terminated, like every other answer). */
export const PROGRAM_STATUS_QUERY_REPLY = `\x1b]7501;?:states=${PROGRAM_STATUS_STATES.join(
  ",",
)}:kinds=${PROGRAM_STATUS_KINDS.join(",")}\x1b\\`;

/** Spec limits (bytes of the payload after `7501;`). */
const MAX_SEQUENCE = 4096;
const MAX_KEY = 16;
const MAX_MSG_ENCODED = 2732;
const MAX_MSG_DECODED = 2048;
const MAX_TITLE_ENCODED = 256;
const MAX_TITLE_DECODED = 192;
const MAX_APP = 32;
const MAX_ID = 128;
const MAX_ID_SEGMENT = 32;
const MAX_ID_DEPTH = 8;

const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/;
const KEY_RE = /^[a-z]+$/;
const APP_RE = /^[A-Za-z0-9_.+-]+$/;
const ID_SEGMENT_RE = /^[A-Za-z0-9_.+-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;

/** Is this OSC 7501 payload the capability query (`?`, possibly with pairs after it)? */
export function isProgramStatusQuery(data: string): boolean {
  return data.split(":")[0].trim() === "?";
}

/**
 * Parse the payload of an `OSC 7501` report (everything after `7501;`).
 * Null when the report must be ignored: no or unknown state, a value past a
 * limit, bad base64, or a control character in a decoded value. A malformed
 * pair on its own is skipped; an unknown key is ignored; a repeated key's
 * last value wins.
 */
export function parseProgramStatus(data: string): ProgramStatusReport | null {
  if (Buffer.byteLength(data, "utf-8") > MAX_SEQUENCE) return null;
  const pairs = new Map<string, string>();
  for (const pair of data.split(":")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!KEY_RE.test(key) || key.length > MAX_KEY || !VALUE_RE.test(value)) continue;
    pairs.set(key, value);
  }

  const state = pairs.get("state");
  if (!state) return null;
  if (state !== "clear" && !(PROGRAM_STATUS_STATES as readonly string[]).includes(state)) {
    return null;
  }

  let id: string | null = null;
  const rawId = pairs.get("id");
  if (rawId) {
    if (rawId.length > MAX_ID) return null;
    const segments = rawId.split("/");
    if (segments.length > MAX_ID_DEPTH) return null;
    for (const segment of segments) {
      if (segment.length > MAX_ID_SEGMENT || !ID_SEGMENT_RE.test(segment)) return null;
    }
    id = rawId;
  }

  let app: string | null = null;
  const rawApp = pairs.get("app");
  if (rawApp) {
    if (rawApp.length > MAX_APP || !APP_RE.test(rawApp)) return null;
    app = rawApp;
  }

  const kindValue = pairs.get("kind");
  const kind =
    kindValue && (PROGRAM_STATUS_KINDS as readonly string[]).includes(kindValue)
      ? (kindValue as ProgramStatusKind)
      : null;

  let progress: number | null = null;
  const rawProgress = pairs.get("progress");
  if (rawProgress !== undefined && /^\d{1,3}$/.test(rawProgress)) {
    const n = Number(rawProgress);
    if (n >= 0 && n <= 100) progress = n;
  }

  const title = decodeText(pairs.get("title"), MAX_TITLE_ENCODED, MAX_TITLE_DECODED);
  if (title === undefined) return null;
  const msg = decodeText(pairs.get("msg"), MAX_MSG_ENCODED, MAX_MSG_DECODED);
  if (msg === undefined) return null;

  return {
    state: state as ProgramStatusReport["state"],
    id,
    kind,
    progress,
    app,
    title,
    msg,
  };
}

/**
 * Decode a base64 text value. Null when absent or empty; undefined when the
 * value is invalid (over a limit, not base64, or decodes to a control
 * character), which discards the whole report.
 */
function decodeText(
  encoded: string | undefined,
  maxEncoded: number,
  maxDecoded: number,
): string | null | undefined {
  if (!encoded) return null;
  if (encoded.length > maxEncoded || !BASE64_RE.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > maxDecoded) return undefined;
  const text = bytes.toString("utf-8");
  if (CONTROL_RE.test(text)) return undefined;
  return text;
}
