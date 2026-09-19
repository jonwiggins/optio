"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * The session title as an always-editable text box: it reads as a heading
 * until you click into it. Follows server updates while you're not editing,
 * saves on Enter / blur, reverts on Escape.
 */
export function TitleEditor({
  terminalId,
  title,
  onSaved,
  className,
  inputClassName,
}: {
  terminalId: string;
  title: string;
  onSaved?: (terminal: any) => void;
  className?: string;
  inputClassName?: string;
}) {
  const [draft, setDraft] = useState(title);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  // Size the box to its text so it sits in the header like a label. The
  // ghost is observed rather than measured once: web fonts land after the
  // first paint and a stale measurement leaves the title clipped to the
  // fallback font's width.
  useEffect(() => {
    const span = spanRef.current;
    if (!span) return;
    const measure = () => setWidth(span.offsetWidth + 18);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(span);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, []);

  const save = async () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) {
      setDraft(title);
      return;
    }
    try {
      const res = await api.updateLocalTerminal(terminalId, { title: next });
      onSaved?.(res.terminal);
    } catch (err) {
      setDraft(title);
      toast.error(err instanceof Error ? err.message : "Failed to rename");
    }
  };

  return (
    <span className={cn("relative inline-flex min-w-0", className)}>
      <span
        ref={spanRef}
        aria-hidden
        className={cn("invisible absolute whitespace-pre pointer-events-none", inputClassName)}
      >
        {draft || " "}
      </span>
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={save}
        onKeyDown={(e) => {
          // Keep the rail's / xterm's global chords out of it.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            inputRef.current?.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(title);
            setEditing(false);
            inputRef.current?.blur();
          }
        }}
        aria-label="Session title"
        title="Click to rename"
        maxLength={200}
        style={width ? { width } : undefined}
        className={cn(
          // The box owns its full border-box slot in the header row: no pull-in
          // margin, or the row's overflow-hidden clips the left edge against
          // the status dot and the right edge lands on the attention text.
          "min-w-[4rem] max-w-full bg-transparent rounded-md px-1.5 py-0.5 border border-transparent truncate transition-colors",
          "hover:border-border hover:bg-bg-card/60 focus:bg-bg-card",
          // The global focus ring sits 2px outside the box, where the same
          // overflow-hidden clips all but its right edge into a stray bar.
          // Pull it inside the border instead (important: the global rule is
          // unlayered, so a plain utility can't beat it).
          "focus-visible:-outline-offset-2!",
          inputClassName,
        )}
      />
    </span>
  );
}
