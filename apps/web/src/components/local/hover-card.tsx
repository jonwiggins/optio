"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** Usage and status details stay inside the viewport, including in narrow split panes. */
export function HoverCard({
  content,
  children,
  align = "right",
  interactive = false,
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  interactive?: boolean;
  className?: string;
}) {
  const trigger = useRef<HTMLSpanElement>(null);
  const id = useId();
  const card = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const close = () => {
    cancelClose();
    // Allow crossing the gap into an interactive card or moving focus to it.
    closeTimer.current = setTimeout(() => {
      if (
        trigger.current?.contains(document.activeElement) ||
        card.current?.contains(document.activeElement)
      )
        return;
      setOpen(false);
      setPosition(null);
    }, 100);
  };
  useEffect(() => () => cancelClose(), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !card.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const box = card.current.getBoundingClientRect();
      const left = align === "right" ? anchor.right - box.width : anchor.left;
      const below = anchor.bottom + 6;
      setPosition({
        left: Math.max(12, Math.min(left, window.innerWidth - box.width - 12)),
        top: Math.max(
          12,
          below + box.height <= window.innerHeight - 12 ? below : anchor.top - box.height - 6,
        ),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (card.current) observer.observe(card.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const dismiss = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (card.current?.contains(document.activeElement)) trigger.current?.focus();
        setOpen(false);
        setPosition(null);
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("keydown", dismiss);
    };
  }, [open, align]);

  return (
    <span
      ref={trigger}
      className={cn("inline-flex", className)}
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      onKeyDown={(event) => {
        if (
          event.target !== trigger.current ||
          event.key !== "Tab" ||
          event.shiftKey ||
          !interactive
        )
          return;
        const first = card.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }}
      onMouseEnter={show}
      onMouseLeave={close}
      onFocus={show}
      onBlur={close}
    >
      {children}
      {open &&
        createPortal(
          <span
            ref={card}
            id={id}
            role="tooltip"
            onMouseEnter={interactive ? show : undefined}
            onMouseLeave={interactive ? close : undefined}
            onFocus={show}
            onBlur={close}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const buttons =
                card.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
              if (event.shiftKey && event.target === buttons?.[0]) {
                event.preventDefault();
                trigger.current?.focus();
              } else if (!event.shiftKey && event.target === buttons?.[buttons.length - 1]) {
                // A portal sits at the end of the document. Continue after
                // its trigger, where this card appears in the reading order.
                const stops = Array.from(
                  document.querySelectorAll<HTMLElement>(
                    'a[href], button, input, textarea, select, [tabindex="0"]',
                  ),
                ).filter(
                  (el) =>
                    !el.matches(":disabled") &&
                    !el.closest("[inert]") &&
                    !card.current?.contains(el) &&
                    el.getClientRects().length > 0 &&
                    getComputedStyle(el).visibility !== "hidden",
                );
                const next = stops[stops.indexOf(trigger.current!) + 1];
                if (next) {
                  event.preventDefault();
                  next.focus();
                  setOpen(false);
                  setPosition(null);
                }
              }
            }}
            className={cn(
              "fixed z-50 block w-max min-w-56 max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-1.5rem)] overflow-auto rounded-xl border border-border bg-bg-card p-3 text-[11px] leading-5 text-text-muted shadow-xl shadow-black/20",
              !interactive && "pointer-events-none",
            )}
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}

export function HoverRow({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <span className="flex items-center justify-between gap-6">
      <span>{label}</span>
      <span className="font-mono tabular-nums text-text">{value}</span>
    </span>
  );
}
