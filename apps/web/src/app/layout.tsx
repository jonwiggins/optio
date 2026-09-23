import type { Metadata, Viewport } from "next";
import { Sora, IBM_Plex_Mono } from "next/font/google";
import { LayoutShell } from "@/components/layout/layout-shell";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-mono",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // iOS zooms the page when focusing an input smaller than 16px (xterm's
  // hidden textarea included); maximumScale: 1 stops that while pinch-zoom
  // keeps working. viewportFit lets us pad for the notch / home indicator.
  maximumScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Optio",
  description: "Workflow orchestration for AI coding agents",
  icons: {
    icon: "/favicon.svg",
  },
};

// The layout reads PUBLIC_API_URL at render time, so it must render per
// request: a statically prerendered route (/sessions, /issues, …) would bake
// the *build-time* value ("" in the Docker build) into its HTML, and since
// the SPA keeps whichever document it started from, every client-side
// navigation out of such a page would open its WebSockets against the wrong
// origin (the Next server instead of the API) until a hard reload from a
// dynamic route. Every page is a client component that fetches its own data,
// so there is nothing to gain from prerendering the shell.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Inject runtime config so client-side code can derive the API WebSocket URL.
  // PUBLIC_API_URL is the browser-reachable API URL (e.g. http://localhost:30400
  // for local dev with NodePort, or empty for production ingress where web and
  // API share the same host).
  const publicApiUrl = process.env.PUBLIC_API_URL ?? "";

  // Default to dark; ThemeProvider applies the correct class on mount
  return (
    <html
      lang="en"
      className={`dark ${sora.variable} ${ibmPlexMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Runtime config for client-side JS (WebSocket URL derivation) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__OPTIO_CONFIG=${JSON.stringify({ publicApiUrl }).replace(/</g, "\\u003c")}`,
          }}
        />
        {/* Inline script to prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("optio_theme");if(t==="light"){document.documentElement.classList.remove("dark");document.documentElement.classList.add("light")}else if(t==="system"&&window.matchMedia("(prefers-color-scheme: light)").matches){document.documentElement.classList.remove("dark");document.documentElement.classList.add("light")}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="antialiased">
        <LayoutShell>{children}</LayoutShell>
      </body>
    </html>
  );
}
