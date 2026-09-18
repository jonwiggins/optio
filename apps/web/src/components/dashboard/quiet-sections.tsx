import Link from "next/link";
import { Moon } from "lucide-react";

export interface QuietSection {
  key: string;
  label: string;
  href: string;
  /** e.g. "3 idle", "12 done", "2 hosts online". */
  summary: string;
  icon: typeof Moon;
}

/**
 * Concepts with nothing live right now, folded into one line so the page
 * only grows for what's actually happening. Each entry still links to its
 * page and shows the one number that says "it exists and here's its size".
 */
export function QuietSections({ sections }: { sections: QuietSection[] }) {
  if (sections.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-text-muted">
      <span className="flex items-center gap-1.5 text-text-muted/60 uppercase tracking-[0.12em] font-semibold text-[10px]">
        <Moon className="w-3 h-3" />
        Quiet
      </span>
      {sections.map((s) => {
        const Icon = s.icon;
        return (
          <Link
            key={s.key}
            href={s.href}
            className="flex items-center gap-1.5 hover:text-text transition-colors"
          >
            <Icon className="w-3 h-3 text-text-muted/60" />
            <span className="font-medium">{s.label}</span>
            <span className="text-text-muted/70">· {s.summary}</span>
          </Link>
        );
      })}
    </div>
  );
}
