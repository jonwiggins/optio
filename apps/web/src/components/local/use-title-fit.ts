"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Decides whether a header's title row must go compact (badges to dots).
 *
 * The rule the user wants: the title keeps its full text until *nothing
 * else* can give way. So we measure what the row would need at full dress
 * — a hidden "ghost" copy of the title text plus badge labels, rendered
 * nowrap — and compare it to the space the row actually has. Measuring a
 * ghost rather than the live row avoids the flip-flop you get from
 * checking "is the title truncated right now?" (hiding the labels frees
 * space, the title fits, the labels come back, the title truncates …).
 *
 * `slack` is width reserved for things not in the ghost (gaps, the
 * separator), in px.
 */
export function useTitleFit(
  /** The header is on screen (refs attached). Re-arms the observer when it flips. */
  ready: boolean,
  slack = 24,
): {
  rowRef: React.RefObject<HTMLDivElement | null>;
  ghostRef: React.RefObject<HTMLDivElement | null>;
  compact: boolean;
} {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const row = rowRef.current;
    const ghost = ghostRef.current;
    if (!ready || !row || !ghost) return;
    const check = () => {
      const need = ghost.scrollWidth + slack;
      const have = row.clientWidth;
      setCompact(need > have);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(row);
    ro.observe(ghost);
    return () => ro.disconnect();
  }, [ready, slack]);

  return { rowRef, ghostRef, compact };
}
