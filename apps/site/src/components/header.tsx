"use client";

import Link from "next/link";
import { useState } from "react";

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-border glass-header">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-xl font-bold text-text-heading tracking-tight">
          optio
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          <Link
            href="/platform"
            className="text-[13px] font-medium text-text-muted hover:text-text transition-colors"
          >
            Approach
          </Link>
          <Link
            href="/docs"
            className="text-[13px] font-medium text-text-muted hover:text-text transition-colors"
          >
            Docs
          </Link>
          <a
            href="https://github.com/jonwiggins/optio"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] font-medium text-text-muted hover:text-text transition-colors"
          >
            GitHub
          </a>
          <Link
            href="/docs/getting-started"
            className="rounded-md bg-primary px-4 py-2 text-[13px] font-medium text-white hover:bg-primary-hover transition-colors"
          >
            Get Started
          </Link>
        </div>

        <button
          type="button"
          className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted transition-colors md:hidden"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle menu"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            {mobileMenuOpen ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            )}
          </svg>
        </button>
      </nav>

      {mobileMenuOpen && (
        <div className="border-t border-border bg-bg-subtle px-6 py-4 md:hidden">
          <div className="flex flex-col gap-4">
            <Link
              href="/platform"
              className="text-[13px] font-medium text-text-muted"
              onClick={() => setMobileMenuOpen(false)}
            >
              Approach
            </Link>
            <Link
              href="/docs"
              className="text-[13px] font-medium text-text-muted"
              onClick={() => setMobileMenuOpen(false)}
            >
              Docs
            </Link>
            <a
              href="https://github.com/jonwiggins/optio"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] font-medium text-text-muted"
              onClick={() => setMobileMenuOpen(false)}
            >
              GitHub
            </a>
            <Link
              href="/docs/getting-started"
              className="rounded-md bg-primary px-4 py-2 text-center text-[13px] font-medium text-white"
              onClick={() => setMobileMenuOpen(false)}
            >
              Get Started
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
