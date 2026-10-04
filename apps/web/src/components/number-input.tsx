"use client";

import { useState, useCallback, useRef, useEffect, type InputHTMLAttributes } from "react";
import { inputClass } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface NumberInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "onChange" | "value" | "min" | "max"
> {
  value: number | string;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  fallback?: number;
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  fallback,
  className = "",
  ...rest
}: NumberInputProps) {
  const [raw, setRaw] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);

  // Sync raw when value changes externally (e.g., API load) while not editing
  useEffect(() => {
    if (!focused.current) {
      setRaw(String(value));
    }
  }, [value]);

  const validate = useCallback(
    (n: number): string | null => {
      if (isNaN(n)) return "Must be a number";
      if (min !== undefined && n < min) return `Min ${min}`;
      if (max !== undefined && n > max) return `Max ${max}`;
      return null;
    },
    [min, max],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setRaw(v);

    if (v === "" || v === "-") {
      setError(null);
      return;
    }

    const n = Number(v);
    if (isNaN(n)) {
      setError("Must be a number");
      return;
    }

    const err = validate(n);
    setError(err);
    if (!err) {
      onChange(n);
    }
  };

  const handleBlur = () => {
    if (raw === "" || raw === "-" || isNaN(Number(raw))) {
      const fb = fallback ?? min ?? 0;
      setRaw(String(fb));
      setError(null);
      onChange(fb);
      return;
    }

    const n = Number(raw);
    const err = validate(n);
    if (err) {
      const clamped = min !== undefined && n < min ? min : max !== undefined && n > max ? max : n;
      setRaw(String(clamped));
      setError(null);
      onChange(clamped);
    } else {
      setRaw(String(n));
    }
  };

  const handleFocus = () => {
    focused.current = true;
    setRaw(String(value));
  };

  const wrappedBlur = () => {
    focused.current = false;
    handleBlur();
  };

  const baseClass = className || inputClass();

  const errorClass = error ? "border-red-500 focus:border-red-500 focus:ring-red-500/20" : "";

  return (
    <div>
      <input
        {...rest}
        type="text"
        inputMode="numeric"
        value={raw}
        onChange={handleChange}
        onBlur={wrappedBlur}
        onFocus={handleFocus}
        className={cn(baseClass, errorClass)}
      />
      {error && <p className="text-[10px] text-red-500 mt-0.5">{error}</p>}
    </div>
  );
}
