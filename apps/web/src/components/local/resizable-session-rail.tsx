"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  clampRailWidth,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  useRailStore,
} from "./rail-store";

/** Desktop resizing leaves the mobile drawer and the collapse shortcut intact. */
export function ResizableSessionRail({ open, children }: { open: boolean; children: ReactNode }) {
  const { collapsed, width, setWidth } = useRailStore();
  const [maxWidth, setMaxWidth] = useState(RAIL_MAX_WIDTH);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const rail = useRef<HTMLElement>(null);
  const visibleWidth = clampRailWidth(width, maxWidth);

  useEffect(() => {
    const resize = () => {
      // Leave room for the session on small laptops; preserve the user's
      // preferred width so it returns when the window gets wider again.
      setMaxWidth(Math.min(RAIL_MAX_WIDTH, Math.floor(window.innerWidth * 0.45)));
      if (window.innerWidth < 768) setDragging(false);
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    if (collapsed) setDragging(false);
  }, [collapsed]);

  useEffect(() => {
    if (!dragging) {
      drag.current = null;
      return;
    }
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const end = () => setDragging(false);
    window.addEventListener("blur", end);
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
      window.removeEventListener("blur", end);
    };
  }, [dragging]);

  return (
    <aside
      ref={rail}
      aria-label="Session sidebar"
      style={{ "--session-rail-width": `${visibleWidth}px` } as CSSProperties}
      className={cn(
        "w-60 md:w-[var(--session-rail-width)] shrink-0 border-r border-border/50 glass-sidebar flex flex-col",
        "fixed inset-y-0 left-0 z-30 transition-transform duration-200 md:relative md:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
        collapsed && "md:hidden",
      )}
    >
      {children}
      <div
        role="separator"
        aria-label="Resize session sidebar"
        aria-orientation="vertical"
        aria-valuemin={RAIL_MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={visibleWidth}
        aria-valuetext={`${visibleWidth} pixels`}
        tabIndex={0}
        title="Drag to resize · Double-click to reset"
        className={cn(
          // Keep the resize target on the terminal side of the divider so it
          // doesn't cover the scrollbar directly inside the sidebar edge.
          "group absolute inset-y-0 -right-2 z-40 hidden w-2 touch-none cursor-col-resize md:flex items-center justify-start",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width: rail.current!.getBoundingClientRect().width };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setWidth(clampRailWidth(drag.current.width + event.clientX - drag.current.x, maxWidth));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          setDragging(false);
        }}
        onPointerCancel={() => setDragging(false)}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={() => setWidth(RAIL_DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          const next =
            event.key === "ArrowLeft"
              ? visibleWidth - 16
              : event.key === "ArrowRight"
                ? visibleWidth + 16
                : event.key === "Home"
                  ? RAIL_MIN_WIDTH
                  : event.key === "End"
                    ? maxWidth
                    : null;
          if (next === null) return;
          event.preventDefault();
          event.stopPropagation();
          setWidth(clampRailWidth(next, maxWidth));
        }}
      >
        <span
          className={cn(
            "h-full w-0.5 transition-colors group-hover:bg-primary group-focus-visible:bg-primary",
            dragging && "bg-primary",
          )}
        />
      </div>
    </aside>
  );
}
