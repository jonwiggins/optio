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

  // Size the box to its text so it sits in the header like a label.
  useEffect(() => {
    if (spanRef.current) setWidth(spanRef.current.offsetWidth + 18);
  }, [draft]);

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
        style={width ? { width: Math.min(width, 480) } : undefined}
        className={cn(
          "min-w-[4rem] max-w-full bg-transparent rounded-md px-1.5 -mx-1.5 border border-transparent outline-none truncate transition-colors",
          "hover:border-border hover:bg-bg-card/60 focus:border-border-strong focus:bg-bg-card",
          inputClassName,
        )}
      />
    </span>
  );
}
