"use client";

import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PanelLeftClose, PanelRightClose } from "lucide-react";

const STORAGE_KEY = "optio-split-pane";
const MIN_PANE_PCT = 15;
const DEFAULT_LEFT_PCT = 45;

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  leftLabel?: string;
  rightLabel?: string;
}

type CollapseState = "none" | "left" | "right";

export function SplitPane({
  left,
  right,
  leftLabel = "Chat",
  rightLabel = "Terminal",
}: SplitPaneProps) {
  const [leftPct, setLeftPct] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_LEFT_PCT;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (typeof parsed.leftPct === "number") return parsed.leftPct;
      } catch {
        // ignore
      }
    }
    return DEFAULT_LEFT_PCT;
  });

  const [collapsed, setCollapsed] = useState<CollapseState>("none");
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Persist layout preference
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ leftPct }));
  }, [leftPct]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.max(MIN_PANE_PCT, Math.min(100 - MIN_PANE_PCT, pct)));
      setCollapsed("none");
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  const toggleLeft = () => {
    setCollapsed((prev) => (prev === "left" ? "none" : "left"));
  };

  const toggleRight = () => {
    setCollapsed((prev) => (prev === "right" ? "none" : "right"));
  };

  const leftWidth = collapsed === "left" ? 0 : collapsed === "right" ? 100 : leftPct;
  const rightWidth = 100 - leftWidth;

  return (
    <div ref={containerRef} className="h-full flex relative">
      {/* Left pane */}
      <div
        className={cn(
          "h-full overflow-hidden transition-[width] duration-200 ease-out",
          collapsed === "left" && "w-0",
        )}
        style={collapsed === "left" ? { width: 0 } : { width: `${leftWidth}%` }}
      >
        <div className="h-full flex flex-col">
          {/* Left pane header */}
          <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-border bg-bg text-xs">
            <span className="font-medium text-text-muted uppercase tracking-wider text-[10px]">
              {leftLabel}
            </span>
            <button
              onClick={toggleLeft}
              className="p-0.5 rounded hover:bg-bg-card text-text-muted hover:text-text transition-colors"
              title={collapsed === "left" ? `Show ${leftLabel}` : `Hide ${leftLabel}`}
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 min-h-0">{left}</div>
        </div>
      </div>

      {/* Drag handle */}
      {collapsed === "none" && (
        <div
          onMouseDown={handleMouseDown}
          className={cn(
            "w-1 shrink-0 cursor-col-resize relative group",
            "bg-border hover:bg-primary/40 transition-colors",
            isDragging && "bg-primary/60",
          )}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>
      )}

      {/* Right pane */}
      <div
        className={cn(
          "h-full overflow-hidden transition-[width] duration-200 ease-out",
          collapsed === "right" && "w-0",
        )}
        style={collapsed === "right" ? { width: 0 } : { width: `${rightWidth}%` }}
      >
        <div className="h-full flex flex-col">
          {/* Right pane header */}
          <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-border bg-bg text-xs">
            <span className="font-medium text-text-muted uppercase tracking-wider text-[10px]">
              {rightLabel}
            </span>
            <button
              onClick={toggleRight}
              className="p-0.5 rounded hover:bg-bg-card text-text-muted hover:text-text transition-colors"
              title={collapsed === "right" ? `Show ${rightLabel}` : `Hide ${rightLabel}`}
            >
              <PanelRightClose className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 min-h-0">{right}</div>
        </div>
      </div>

      {/* Collapse/expand buttons when panes are hidden */}
      {collapsed === "left" && (
        <button
          onClick={toggleLeft}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 bg-bg-card border border-border rounded-r-md px-1 py-3 text-text-muted hover:text-text transition-colors"
          title={`Show ${leftLabel}`}
        >
          <PanelLeftClose className="w-3.5 h-3.5 rotate-180" />
        </button>
      )}
      {collapsed === "right" && (
        <button
          onClick={toggleRight}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 bg-bg-card border border-border rounded-l-md px-1 py-3 text-text-muted hover:text-text transition-colors"
          title={`Show ${rightLabel}`}
        >
          <PanelRightClose className="w-3.5 h-3.5 rotate-180" />
        </button>
      )}

      {/* Drag overlay to prevent iframe/xterm from capturing mouse */}
      {isDragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  );
}
