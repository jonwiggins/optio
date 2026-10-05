import Link from "next/link";
import Image from "next/image";

export function Footer() {
  return (
    <footer className="relative z-10 border-t border-border bg-bg-subtle">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <Link
              href="/"
              className="flex items-center gap-2 text-lg font-bold text-text-heading tracking-tight"
            >
              <Image src="/optio-mark.svg" alt="" width={24} height={24} />
              optio
            </Link>
            <p className="mt-2 text-[13px] text-text-muted leading-relaxed">
              Workflow orchestration for
              <br />
              AI coding agents.
            </p>
          </div>

          <div>
            <h3 className="text-[13px] font-semibold text-text-heading">Documentation</h3>
            <ul className="mt-3 space-y-2">
              <li>
                <Link
                  href="/docs/getting-started"
                  className="text-[13px] text-text-muted hover:text-text transition-colors"
                >
                  Getting Started
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/installation"
                  className="text-[13px] text-text-muted hover:text-text transition-colors"
                >
                  Installation
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/api-reference"
                  className="text-[13px] text-text-muted hover:text-text transition-colors"
                >
                  API Reference
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-[13px] font-semibold text-text-heading">Community</h3>
            <ul className="mt-3 space-y-2">
              <li>
                <a
                  href="https://github.com/jonwiggins/optio"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] text-text-muted hover:text-text transition-colors"
                >
                  GitHub
                </a>
              </li>
              <li>
                <Link
                  href="/docs/contributing"
                  className="text-[13px] text-text-muted hover:text-text transition-colors"
                >
                  Contributing
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-[13px] font-semibold text-text-heading">Legal</h3>
            <ul className="mt-3 space-y-2">
              <li>
                <span className="text-[13px] text-text-muted">MIT License</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 border-t border-border pt-8 text-center text-[13px] text-text-muted">
          &copy; {new Date().getFullYear()} Optio. Open source under the MIT license.
        </div>
      </div>
    </footer>
  );
}
