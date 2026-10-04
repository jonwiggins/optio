"use client";

import { useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Segmented } from "@/components/ui/segmented";
import {
  OWNER_SCOPE_LABEL,
  countByOwner,
  parseOwnerFilter,
  type Owned,
  type OwnerFilter,
} from "@/lib/owner";

/**
 * The scope switch every list page carries in the same place: **All ·
 * Organization · Private**, plus **Other people's** for an admin when there
 * are any. `All` is sectioned (`ScopedList`); the rest are flat. Counts come
 * from the rows; the choice lives in the URL (`?owner=`) so links carry it.
 *
 *   const [owner, setOwner] = useOwnerFilter();
 *   <OwnerSegments rows={rows} viewerId={userId} value={owner} onChange={setOwner} />
 */
export function OwnerSegments<T extends Owned>({
  rows,
  viewerId,
  value,
  onChange,
  className,
  size = "md",
}: {
  rows: T[];
  viewerId: string | null;
  value: OwnerFilter;
  onChange: (v: OwnerFilter) => void;
  className?: string;
  /** `md` on list pages; `sm` beside another control (the Work list's view switcher). */
  size?: "sm" | "md";
}) {
  const counts = countByOwner(rows, viewerId);
  const options: Array<{ value: OwnerFilter; label: string; count: number }> = [
    { value: "all", label: "All", count: counts.all },
    { value: "organization", label: OWNER_SCOPE_LABEL.organization, count: counts.organization },
    { value: "private", label: OWNER_SCOPE_LABEL.private, count: counts.private },
  ];
  // Only an admin ever receives other people's private rows.
  if (counts.others > 0 || value === "others") {
    options.push({ value: "others", label: OWNER_SCOPE_LABEL.others, count: counts.others });
  }
  return (
    <Segmented
      size={size}
      surface="card"
      wrap
      className={className ?? "gap-1"}
      aria-label="Filter by owner"
      value={options.some((o) => o.value === value) ? value : "all"}
      onChange={onChange}
      options={options}
    />
  );
}

/** The `?owner=` filter of the current page, kept in the URL (replace, no scroll). */
export function useOwnerFilter(): [OwnerFilter, (v: OwnerFilter) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState<OwnerFilter>(() => parseOwnerFilter(params.get("owner")));
  const set = useCallback(
    (v: OwnerFilter) => {
      setValue(v);
      const next = new URLSearchParams(params.toString());
      if (v === "all") next.delete("owner");
      else next.set("owner", v);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return [value, set];
}
