"use client";

import { useRef } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { inputClass } from "./input";

const SIZES = {
  md: {
    icon: "left-3 h-4 w-4",
    input: "pl-9 pr-9",
    clear: "right-1.5 p-1.5",
    x: "h-3.5 w-3.5",
  },
  sm: {
    icon: "left-2 h-3.5 w-3.5",
    input: "pl-7 pr-7",
    clear: "right-1 p-1",
    x: "h-3 w-3",
  },
} as const;

/**
 * A search box: a magnifier on the left and, once there is text, an × on the
 * right that clears it and keeps the focus in the field. Every list's search
 * goes through it so they all look and clear the same way.
 */
export function SearchField({
  value,
  onChange,
  label,
  placeholder = label,
  size = "md",
  className,
  inputClassName,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name; also the placeholder unless one is given. */
  label: string;
  placeholder?: string;
  size?: keyof typeof SIZES;
  /** Layout of the box itself (width, margins). */
  className?: string;
  /** Extra classes on the `<input>` (background, radius). */
  inputClassName?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const s = SIZES[size];
  return (
    <div className={cn("relative", className)}>
      <Search
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-text-muted",
          s.icon,
        )}
      />
      <input
        ref={ref}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass({
          size,
          className: cn(
            "[&::-webkit-search-cancel-button]:appearance-none",
            s.input,
            inputClassName,
          ),
        })}
      />
      {value && (
        <button
          type="button"
          aria-label={`Clear ${label.toLowerCase()}`}
          title="Clear"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
          className={cn(
            "absolute top-1/2 -translate-y-1/2 rounded-md text-text-muted hover:bg-bg-hover hover:text-text",
            s.clear,
          )}
        >
          <X className={s.x} />
        </button>
      )}
    </div>
  );
}
