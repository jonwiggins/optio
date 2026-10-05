import { OPTIO_MARK_PATHS } from "@/lib/optio-brand";

/** Optio's decorative mark; the adjacent product name supplies its accessible label. */
export function OptioMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" fill="currentColor" aria-hidden="true" className={className}>
      {OPTIO_MARK_PATHS.map((d) => (
        <path key={d} d={d} fillRule="evenodd" />
      ))}
    </svg>
  );
}
