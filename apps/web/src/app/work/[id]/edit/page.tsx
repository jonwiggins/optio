"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { usePageTitle } from "@/hooks/use-page-title";
import { WorkForm } from "@/components/work-form/work-form";
import { loadEditTarget, type EditTarget } from "@/components/work-form/load";

/**
 * Edit recurring work — a scheduled Task, a Job, or a Local automation —
 * in the same form that made it. The id is resolved across all three tables;
 * anything that isn't a definition (a one-shot run, a terminal, an agent)
 * has no edit form and is sent back to the list.
 */
export default function EditWorkPage() {
  const { id } = useParams<{ id: string }>();
  const [target, setTarget] = useState<EditTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePageTitle(target ? `Edit ${target.draft.name || "work"}` : "Edit work");

  useEffect(() => {
    let cancelled = false;
    setTarget(null);
    setError(null);
    loadEditTarget(id)
      .then((t) => {
        if (!cancelled) setTarget(t);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        setError(
          err?.status === 404
            ? "Nothing with that id."
            : err?.status === 405
              ? "Only recurring work has an edit form — one-shot runs, terminals, and agents are managed from their own pages."
              : (err?.message ?? "Couldn't load it."),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold tracking-tight mb-2">Edit work</h1>
        <p className="text-sm text-error mb-4">{error}</p>
        <Link href="/work" className="text-sm text-primary hover:underline">
          Back to Work
        </Link>
      </div>
    );
  }

  if (!target) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading...
      </div>
    );
  }

  return <WorkForm key={target.id} edit={target} />;
}
