"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";

/** Native scrolling with a draggable overlay thumb, without a reserved gutter. */
export function SessionRailScroll({
  children,
  viewportRef,
  className,
}: {
  children: ReactNode;
  viewportRef?: RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  const internalRef = useRef<HTMLDivElement>(null);
  const viewport = viewportRef ?? internalRef;
  const content = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const dragOffset = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [metrics, setMetrics] = useState({ height: 0, total: 0, top: 0 });

  useEffect(() => {
    const el = viewport.current;
    if (!el || !content.current) return;
    const measure = () => {
      const next = { height: el.clientHeight, total: el.scrollHeight, top: el.scrollTop };
      setMetrics((prev) =>
        prev.height === next.height && prev.total === next.total && prev.top === next.top
          ? prev
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(content.current);
    el.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [viewport]);

  const max = Math.max(0, metrics.total - metrics.height);
  const scrollable = max > 0;
  useEffect(() => {
    const track = trackRef.current;
    const el = viewport.current;
    if (!track || !el) return;
    // The track is a sibling of the viewport. Wheel events over the thumb
    // must still scroll the list instead of falling through to the page.
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY || event.ctrlKey) return;
      event.preventDefault();
      const unit =
        event.deltaMode === 2
          ? el.clientHeight
          : event.deltaMode === 1
            ? parseFloat(getComputedStyle(el).lineHeight) || 16
            : 1;
      el.scrollTop += event.deltaY * unit;
    };
    track.addEventListener("wheel", wheel, { passive: false });
    return () => track.removeEventListener("wheel", wheel);
  }, [scrollable, viewport]);
  const thumbHeight = Math.min(
    metrics.height,
    Math.max(28, (metrics.height * metrics.height) / (metrics.total || 1)),
  );
  const travel = metrics.height - thumbHeight;
  const thumbTop = max > 0 ? (Math.min(metrics.top, max) / max) * travel : 0;
  const moveTo = (clientY: number, track: HTMLElement) => {
    if (!viewport.current || dragOffset.current === null || travel <= 0) return;
    const top = clientY - track.getBoundingClientRect().top - dragOffset.current;
    viewport.current.scrollTop = (Math.max(0, Math.min(top, travel)) / travel) * max;
  };

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={viewport}
        id={id}
        role="region"
        aria-label="Sessions"
        tabIndex={0}
        className="session-rail-scroll h-full overflow-y-auto overflow-x-hidden overscroll-contain"
      >
        <div ref={content} className={className}>
          {children}
        </div>
      </div>
      {max > 0 && (
        <div
          ref={trackRef}
          role="scrollbar"
          aria-label="Scroll sessions"
          aria-controls={id}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={Math.round(max)}
          aria-valuenow={Math.round(Math.max(0, Math.min(metrics.top, max)))}
          tabIndex={0}
          className="group/scroll absolute inset-y-0 right-0 z-10 w-3 touch-none select-none cursor-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
            dragOffset.current =
              y >= thumbTop && y <= thumbTop + thumbHeight ? y - thumbTop : thumbHeight / 2;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
            moveTo(event.clientY, event.currentTarget);
          }}
          onPointerMove={(event) => moveTo(event.clientY, event.currentTarget)}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            dragOffset.current = null;
            setDragging(false);
          }}
          onLostPointerCapture={() => {
            dragOffset.current = null;
            setDragging(false);
          }}
          onKeyDown={(event) => {
            const el = viewport.current;
            if (!el) return;
            const next =
              event.key === "ArrowUp"
                ? el.scrollTop - 40
                : event.key === "ArrowDown"
                  ? el.scrollTop + 40
                  : event.key === "PageUp"
                    ? el.scrollTop - el.clientHeight
                    : event.key === "PageDown"
                      ? el.scrollTop + el.clientHeight
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? max
                          : null;
            if (next === null) return;
            event.preventDefault();
            event.stopPropagation();
            el.scrollTop = next;
          }}
        >
          <div
            data-session-scroll-thumb
            className={cn(
              "session-rail-thumb absolute right-0.5 w-0.5 rounded-full bg-text-muted/60 group-hover/scroll:bg-text-muted group-focus-visible/scroll:bg-text-muted",
              dragging && "bg-text-muted",
            )}
            style={{ height: thumbHeight, transform: `translateY(${thumbTop}px)` }}
          />
        </div>
      )}
    </div>
  );
}
