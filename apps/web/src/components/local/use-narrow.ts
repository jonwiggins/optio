"use client";

import { useEffect, useState } from "react";

/** Below Tailwind's `sm` breakpoint — a phone-width viewport. */
const NARROW_QUERY = "(max-width: 639px)";

/** Whether the viewport is phone-width; follows resizes and rotation. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(NARROW_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return narrow;
}
