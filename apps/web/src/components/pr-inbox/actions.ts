"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { PrInboxItem } from "@optio/shared";
import { api } from "@/lib/api-client";
import { mergeMethodFor, type BulkAction, type RowAction } from "./model";

/** What an action did, in a few words, for a toast. */
type Outcome = { ok: true; message: string; href?: string } | { ok: false; message: string };

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/** Run one action on one PR (no toast: callers decide how to report). */
async function perform(item: PrInboxItem, action: RowAction | BulkAction): Promise<Outcome> {
  const { facts } = item;
  try {
    switch (action.kind) {
      case "agent": {
        const res = await api.sendPrToAgent({ prUrl: facts.url, action: action.action });
        return {
          ok: true,
          message:
            res.mode === "created"
              ? `An agent is on #${facts.number}`
              : `The agent picked #${facts.number} back up`,
          href: `/work/${res.taskId}`,
        };
      }
      case "quick": {
        const res = await api.runPrQuickAction({ prUrl: facts.url, action: action.action });
        return { ok: true, message: res.message };
      }
      case "optio-review": {
        const res = await api.createPrReview({ prUrl: facts.url });
        return {
          ok: true,
          message: `Optio is reviewing #${facts.number}`,
          href: `/reviews/${res.review.id}`,
        };
      }
      case "merge": {
        await api.mergePullRequest({
          prUrl: facts.url,
          mergeMethod: "method" in action ? action.method : mergeMethodFor(facts),
          // Refuse if someone pushed since this page last looked.
          ...(facts.platform === "github" && facts.headSha
            ? { expectedHeadSha: facts.headSha }
            : {}),
        });
        return { ok: true, message: `Merged #${facts.number}` };
      }
      case "copy-link":
        await navigator.clipboard.writeText(facts.url);
        return { ok: true, message: "Link copied" };
      default:
        return { ok: false, message: "Nothing to run" };
    }
  } catch (err) {
    return { ok: false, message: `#${facts.number}: ${errorText(err, "it didn't work")}` };
  }
}

/**
 * `run(item, action)` for a row; `runBulk(items, action)` for a whole bucket,
 * one PR after another, with one summary toast. Both call `onChanged` after.
 */
export function usePrActions(onChanged: () => void) {
  const router = useRouter();

  const run = useCallback(
    async (item: PrInboxItem, action: RowAction): Promise<boolean> => {
      const out = await perform(item, action);
      if (!out.ok) {
        toast.error(out.message);
        return false;
      }
      const href = out.href;
      toast.success(
        out.message,
        href && action.kind !== "optio-review"
          ? { action: { label: "Watch", onClick: () => router.push(href) } }
          : undefined,
      );
      if (action.kind === "optio-review" && href) router.push(href);
      else if (action.kind !== "copy-link") onChanged();
      return true;
    },
    [onChanged, router],
  );

  const runBulk = useCallback(
    async (items: PrInboxItem[], action: BulkAction): Promise<void> => {
      const results: Outcome[] = [];
      for (const item of items) results.push(await perform(item, action));
      const done = results.filter((r) => r.ok).length;
      const failed = results.filter((r): r is { ok: false; message: string } => !r.ok);
      if (failed.length === 0) {
        toast.success(`${action.label}: done for ${done} PR${done === 1 ? "" : "s"}`);
      } else {
        toast.error(`${action.label}: ${done} of ${results.length} done`, {
          description: failed.map((f) => f.message).join("\n"),
        });
      }
      onChanged();
    },
    [onChanged],
  );

  return { run, runBulk };
}
