"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsSection {
  id: string;
  title: string;
  description: string;
  content: ReactNode;
}

/** Anchor navigation keeps forms mounted, so moving between sections preserves edits. */
export function SettingsLayout({ sections }: { sections: SettingsSection[] }) {
  const [active, setActive] = useState(sections[0]?.id);
  const contentRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const anchorRef = useRef<string | null>(null);
  const ids = sections.map((section) => section.id).join(",");
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-10% 0px -65% 0px" },
    );
    for (const id of ids.split(",")) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, [ids]);
  useEffect(() => {
    // A clicked section must stay in view as earlier cards replace their
    // skeletons. Stop following it as soon as the user scrolls or interacts.
    const align = () => {
      if (anchorRef.current)
        document.getElementById(anchorRef.current)?.scrollIntoView({ block: "start" });
    };
    const stop = () => {
      anchorRef.current = null;
    };
    const pointer = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) stop();
    };
    const key = (event: KeyboardEvent) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Tab"].includes(
          event.key,
        )
      )
        stop();
    };
    const observer = new ResizeObserver(align);
    if (contentRef.current) observer.observe(contentRef.current);
    window.addEventListener("wheel", stop, { passive: true, capture: true });
    window.addEventListener("touchstart", stop, { passive: true, capture: true });
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", key, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("wheel", stop, true);
      window.removeEventListener("touchstart", stop, true);
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", key, true);
    };
  }, []);
  return (
    <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
      <nav
        ref={navRef}
        aria-label="Settings sections"
        className="sticky top-0 z-10 -mx-4 border-b border-border/60 bg-bg/95 px-4 py-2 backdrop-blur-sm sm:-mx-6 sm:px-6 lg:top-6 lg:mx-0 lg:w-44 lg:shrink-0 lg:border-0 lg:bg-transparent lg:p-0"
      >
        <p className="mb-3 hidden px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted/70 lg:block">
          On this page
        </p>
        <div className="flex gap-1 overflow-x-auto lg:flex-col">
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              onClick={() => {
                anchorRef.current = section.id;
                setActive(section.id);
              }}
              aria-current={active === section.id ? "location" : undefined}
              className={cn(
                "shrink-0 rounded-lg px-3 py-2 text-sm transition-colors",
                active === section.id
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-text-muted hover:bg-bg-hover hover:text-text",
              )}
            >
              {section.title}
            </a>
          ))}
        </div>
      </nav>
      <div ref={contentRef} className="min-w-0 max-w-3xl flex-1 space-y-10">
        {sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-labelledby={`${section.id}-heading`}
            className="scroll-mt-20 lg:scroll-mt-6"
          >
            <div className="mb-4">
              <h2
                id={`${section.id}-heading`}
                className="text-base font-semibold tracking-tight text-text-heading"
              >
                {section.title}
              </h2>
              <p className="mt-1 text-sm text-text-muted">{section.description}</p>
            </div>
            <div className="space-y-4">{section.content}</div>
          </section>
        ))}
      </div>
    </div>
  );
}
