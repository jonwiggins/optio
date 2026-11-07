/**
 * Automatic merging, optionally behind a confirmation. By default `autoMerge`
 * alone decides, as it always has. A deployment may require more
 * (Settings → Access → Automatic merging, `OPTIO_MERGE_CONFIRMATION`): then
 * a person ticks the checkbox AND accepts the confirmation dialog, and only
 * then does Optio merge a PR / MR by itself. Every write that turns
 * `autoMerge` on (a repo, a Task, a scheduled Task, "Works until merged" on
 * new work, config-as-code, the controller's tools) may carry
 * `autoMergeConfirmed: true` — what the dialog sends — and stamps when (and,
 * for a repo, by whom) it was confirmed. Turning it off clears the stamp.
 *
 * With the confirmation required (`required`), the reconciler merges only
 * when the effective setting is on AND confirmed (`effectiveAutoMerge`), so
 * a row that was on before the stamp existed waits until someone confirms it
 * again. Merging by hand (the Merge button, the controller's merge_pr) is
 * unaffected.
 */

/** The 400 every write answers when it turns automatic merging on unconfirmed. */
export const AUTO_MERGE_CONFIRMATION_MESSAGE =
  "Automatic merging needs the checkbox and the confirmation";

/** What a write says about automatic merging. */
export interface AutoMergeInput {
  /** The new value; unset = this write leaves it as it is. */
  autoMerge?: boolean | null;
  /** True only when the person accepted the confirmation dialog. */
  autoMergeConfirmed?: boolean | null;
}

/**
 * The 400 message when `input` turns automatic merging on without the
 * confirmation the deployment `required`, or null when the write may go
 * ahead: no confirmation required, turning it off, leaving it alone, on and
 * confirmed now, or on and already confirmed before (`current` — a settings
 * page that saves every field again needn't ask twice).
 */
export function requireAutoMergeConfirmation(
  input: AutoMergeInput,
  current: AutoMergeSetting | null | undefined,
  required: boolean,
): string | null {
  if (!required) return null;
  if (input.autoMerge !== true) return null;
  if (input.autoMergeConfirmed === true) return null;
  return isAutoMergeConfirmed(current) ? null : AUTO_MERGE_CONFIRMATION_MESSAGE;
}

/** The confirmation columns a write stores next to `autoMerge`. */
export interface AutoMergeStamp {
  autoMergeConfirmedAt: Date | null;
  autoMergeConfirmedBy: string | null;
}

/**
 * The stamp a write stores (after `requireAutoMergeConfirmation` passed):
 * confirmed now → now and who; off or null (inherit) → cleared. Undefined —
 * keep the stamp the row has — when the write doesn't touch `autoMerge`, or
 * saves it on again without a new confirmation (it was confirmed before).
 */
export function autoMergeStamp(
  input: AutoMergeInput,
  by: string | null | undefined,
  now: Date = new Date(),
): AutoMergeStamp | undefined {
  if (input.autoMerge === undefined) return undefined;
  if (input.autoMerge !== true) return { autoMergeConfirmedAt: null, autoMergeConfirmedBy: null };
  return input.autoMergeConfirmed === true
    ? { autoMergeConfirmedAt: now, autoMergeConfirmedBy: by ?? null }
    : undefined;
}

/**
 * The stamp a new row starts with: who and when, only when this write turned
 * merging on with the dialog accepted; nothing otherwise.
 */
export function newAutoMergeStamp(
  input: AutoMergeInput,
  by: string | null | undefined,
  now: Date = new Date(),
): AutoMergeStamp {
  return (
    autoMergeStamp(input, by, now) ?? { autoMergeConfirmedAt: null, autoMergeConfirmedBy: null }
  );
}

/** A row's automatic-merge setting as stored. */
export interface AutoMergeSetting {
  autoMerge?: boolean | null;
  autoMergeConfirmedAt?: Date | string | null;
}

/** Whether a row's automatic merging is on and was confirmed. */
export function isAutoMergeConfirmed(setting: AutoMergeSetting | null | undefined): boolean {
  return setting?.autoMerge === true && !!setting.autoMergeConfirmedAt;
}

/**
 * The setting a run merges by: the run's own when it has one (a Task's
 * "Works until merged"), otherwise the repo's. `autoMerge` is what was asked
 * for; `autoMergeConfirmed` whether that ask may merge — confirmed, when the
 * deployment `required` the confirmation; otherwise the ask itself. The
 * reconciler merges only when both are true.
 */
export function effectiveAutoMerge(
  run: AutoMergeSetting | null | undefined,
  repo: AutoMergeSetting | null | undefined,
  required: boolean,
): { autoMerge: boolean; autoMergeConfirmed: boolean } {
  const own = run?.autoMerge;
  const source = own === true || own === false ? run : repo;
  const autoMerge = source?.autoMerge === true;
  return {
    autoMerge,
    autoMergeConfirmed: required ? isAutoMergeConfirmed(source) : autoMerge,
  };
}
