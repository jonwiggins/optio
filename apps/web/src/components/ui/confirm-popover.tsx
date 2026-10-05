"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button, buttonClass } from "./button";

/**
 * An "are you sure?" card that opens right under the control that asked,
 * styled like the hover cards in the session chrome (the usage pills), so
 * the answer is one short mouse move away rather than a browser dialog in
 * the middle of the screen. Wrap the control in it and flip `open`:
 *
 *   <ConfirmPopover open={asking} onCancel={…} onConfirm={…} title="Kill the process?" confirmLabel="Kill">
 *     <button onClick={() => setAsking(true)}>Kill</button>
 *   </ConfirmPopover>
 *
 * Escape and a click outside cancel; the confirm button takes focus when
 * the card opens so Enter confirms.
 */
export function ConfirmPopover({
  open,
  title,
  detail,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  align = "right",
  onConfirm,
  onCancel,
  className,
  children,
}: {
  open: boolean;
  title: string;
  detail?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  align?: "left" | "right";
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    confirm.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, onCancel]);

  return (
    <span ref={root} className={cn("relative inline-flex", className)}>
      {children}
      {open && (
        <span
          className={cn("absolute top-full pt-1.5 z-40", align === "right" ? "right-0" : "left-0")}
        >
          <span
            role="dialog"
            aria-modal="false"
            aria-labelledby={titleId}
            data-testid="confirm-popover"
            className="block min-w-[14rem] rounded-lg border border-border bg-bg-card shadow-xl shadow-black/30 p-3 text-[11px] leading-5 text-text-muted whitespace-nowrap"
          >
            <span id={titleId} className="block font-medium text-text">
              {title}
            </span>
            {detail && <span className="block text-[10px] text-text-muted/80">{detail}</span>}
            <span className="mt-2 flex items-center justify-end gap-1.5">
              <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                {cancelLabel}
              </Button>
              <button
                ref={confirm}
                type="button"
                className={buttonClass({ variant: "danger", size: "sm" })}
                onClick={onConfirm}
                disabled={busy}
              >
                {confirmLabel}
              </button>
            </span>
          </span>
        </span>
      )}
    </span>
  );
}
