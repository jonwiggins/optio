"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PanelLeftClose, PanelRightClose } from "lucide-react";

const STORAGE_KEY = "optio-split-pane";
const MIN_PANE_PCT = 15;
const DEFAULT_LEFT_PCT = 45;
const clamp = (value: number) => Math.max(MIN_PANE_PCT, Math.min(100 - MIN_PANE_PCT, value));

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  leftLabel?: string;
  rightLabel?: string;
  revealRightKey?: string;
}
type CollapseState = "none" | "left" | "right";

export function SplitPane({
  left,
  right,
  leftLabel = "Chat",
  rightLabel = "Terminal",
  revealRightKey,
}: SplitPaneProps) {
  const [leftPct, setLeftPct] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (typeof saved?.leftPct === "number" && Number.isFinite(saved.leftPct))
        return clamp(saved.leftPct);
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
    return DEFAULT_LEFT_PCT;
  });
  const [collapsed, setCollapsed] = useState<CollapseState>("none");
  const [compact, setCompact] = useState(false);
  const [active, setActive] = useState<"left" | "right">("left");
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 640));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (revealRightKey) {
      setCollapsed((prev) => (prev === "right" ? "none" : prev));
      setActive("right");
    }
  }, [revealRightKey]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ leftPct }));
    } catch {
      /* Optional preference. */
    }
  }, [leftPct]);
  useEffect(() => {
    if (!isDragging) return;
    const move = (event: PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect?.width) setLeftPct(clamp(((event.clientX - rect.left) / rect.width) * 100));
    };
    const stop = () => setIsDragging(false);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, [isDragging]);
  const leftWidth = collapsed === "left" ? 0 : collapsed === "right" ? 100 : leftPct;
  return (
    <div ref={containerRef} className="relative flex h-full min-w-0 flex-col">
      {compact && (
        <div
          role="group"
          aria-label="Session view"
          className="flex shrink-0 gap-1 border-b border-border/70 bg-bg-card/40 p-2"
        >
          {(["left", "right"] as const).map((side) => (
            <button
              key={side}
              type="button"
              aria-pressed={active === side}
              onClick={() => setActive(side)}
              className={cn(
                "flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors",
                active === side
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-bg-hover",
              )}
            >
              {side === "left" ? leftLabel : rightLabel}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {(["left", "right"] as const).map((side) => (
          <Pane
            key={side}
            side={side}
            label={side === "left" ? leftLabel : rightLabel}
            compact={compact}
            hidden={compact ? active !== side : collapsed === side}
            width={compact ? 100 : side === "left" ? leftWidth : 100 - leftWidth}
            onHide={() => setCollapsed(side)}
          >
            {side === "left" ? left : right}
          </Pane>
        ))}
        {!compact && collapsed === "none" && (
          <div
            role="separator"
            aria-label="Resize chat and terminal"
            aria-orientation="vertical"
            aria-valuenow={Math.round(leftPct)}
            aria-valuemin={MIN_PANE_PCT}
            aria-valuemax={100 - MIN_PANE_PCT}
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDoubleClick={() => setLeftPct(DEFAULT_LEFT_PCT)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              setLeftPct((value) =>
                event.key === "Home"
                  ? MIN_PANE_PCT
                  : event.key === "End"
                    ? 100 - MIN_PANE_PCT
                    : clamp(value + (event.key === "ArrowLeft" ? -2 : 2)),
              );
            }}
            className={cn(
              "order-2 relative z-10 w-px shrink-0 touch-none cursor-col-resize bg-border transition-colors hover:bg-primary focus-visible:bg-primary",
              isDragging && "bg-primary",
            )}
          >
            <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
          </div>
        )}
      </div>
      {!compact && collapsed !== "none" && (
        <button
          type="button"
          onClick={() => setCollapsed("none")}
          title={`Show ${collapsed === "left" ? leftLabel : rightLabel}`}
          className={cn(
            "absolute top-1/2 z-10 -translate-y-1/2 border border-border bg-bg-card px-1.5 py-3 text-text-muted shadow-sm hover:text-text",
            collapsed === "left" ? "left-0 rounded-r-lg" : "right-0 rounded-l-lg",
          )}
        >
          {collapsed === "left" ? (
            <PanelLeftClose className="h-4 w-4 rotate-180" />
          ) : (
            <PanelRightClose className="h-4 w-4 rotate-180" />
          )}
        </button>
      )}
      {isDragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  );
}

function Pane({
  side,
  label,
  compact,
  hidden,
  width,
  onHide,
  children,
}: {
  side: "left" | "right";
  label: string;
  compact: boolean;
  hidden: boolean;
  width: number;
  onHide: () => void;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      aria-hidden={hidden}
      inert={hidden}
      className={cn(
        "h-full min-w-0 overflow-hidden",
        side === "left" ? "order-1" : "order-3",
        hidden && "w-0 hidden",
      )}
      style={{ width: `${width}%` }}
    >
      <div className="flex h-full flex-col">
        {!compact && (
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 bg-bg-card/40 px-4">
            <span className="text-xs font-medium text-text-muted">{label}</span>
            <button
              type="button"
              onClick={onHide}
              className="rounded-md p-1.5 text-text-muted/70 transition-colors hover:bg-bg-hover hover:text-text"
              title={`Hide ${label}`}
            >
              {side === "left" ? (
                <PanelLeftClose className="h-3.5 w-3.5" />
              ) : (
                <PanelRightClose className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </section>
  );
}
