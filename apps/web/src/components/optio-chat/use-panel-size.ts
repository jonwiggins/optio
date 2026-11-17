"use client";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { usePathname } from "next/navigation";

export function usePanelSize() {
  const pathname = usePathname();
  const [left, setLeft] = useState(252);
  const leftRef = useRef(252);
  const [size, setSize] = useState({ width: 520, height: 740 });
  const drag = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const clamp = (width: number, height: number) => ({
    width: Math.max(360, Math.min(width, window.innerWidth - leftRef.current - 12)),
    height: Math.max(
      Math.min(360, window.innerHeight - 24),
      Math.min(height, window.innerHeight - 24),
    ),
  });
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("optio.agent.size") || "null");
      if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height))
        setSize(clamp(saved.width, saved.height));
    } catch {
      /* A missing preference uses the default size. */
    }
  }, []);
  useEffect(() => {
    const rail = document.querySelector("[data-optio-agent-launcher]")?.closest("aside");
    const resize = () => {
      const edge = rail?.getBoundingClientRect().right ?? 0;
      const inset = Math.max(12, Math.min(edge + 12, window.innerWidth - 372));
      leftRef.current = inset;
      setLeft(inset);
      if (window.innerWidth >= 768) setSize((s) => clamp(s.width, s.height));
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (rail) observer.observe(rail);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [pathname]);
  const save = () =>
    setSize((s) => {
      try {
        localStorage.setItem("optio.agent.size", JSON.stringify(s));
      } catch {
        /* Optional preference. */
      }
      return s;
    });
  const handle = (axis: "width" | "height" | "both") => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = e.currentTarget.closest("aside")!.getBoundingClientRect();
      drag.current = { x: e.clientX, y: e.clientY, width: rect.width, height: rect.height };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d) return;
      setSize(
        clamp(
          axis === "height" ? d.width : d.width + e.clientX - d.x,
          axis === "width" ? d.height : d.height + d.y - e.clientY,
        ),
      );
    },
    onPointerUp: () => {
      drag.current = null;
      save();
    },
    onPointerCancel: () => {
      drag.current = null;
    },
    onLostPointerCapture: () => {
      drag.current = null;
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      const step = e.shiftKey ? 64 : 24;
      const dx = axis !== "height" ? { ArrowLeft: -step, ArrowRight: step }[e.key] || 0 : 0;
      const dy = axis !== "width" ? { ArrowUp: step, ArrowDown: -step }[e.key] || 0 : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      setSize((s) => clamp(s.width + dx, s.height + dy));
      save();
    },
  });
  return {
    style: {
      "--agent-left": `${left}px`,
      "--agent-width": `${size.width}px`,
      "--agent-height": `${size.height}px`,
    } as CSSProperties,
    handle,
  };
}
