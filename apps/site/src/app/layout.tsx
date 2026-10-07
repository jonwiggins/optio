import type { Metadata } from "next";
import { Sora, IBM_Plex_Mono } from "next/font/google";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sora",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-ibm-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://optio.host"),
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: "/apple-touch-icon.png",
  },
  title: {
    default: "Optio — All your agent work. One place to run it.",
    template: "%s | Optio",
  },
  description:
    "Run coding agents, automate workflows, and pick up sessions from native iOS and Android apps. Self-hosted on Kubernetes and your own machines. Open source, MIT licensed.",
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Optio",
    title: "Optio — All your agent work. One place to run it.",
    description:
      "Coding agents, scheduled jobs, event automations, and interactive sessions. Your cluster, your machines, and native apps in your pocket.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Optio — All your agent work. One place to run it.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Optio — All your agent work. One place to run it.",
    description:
      "Coding agents, scheduled jobs, event automations, and interactive sessions. Your cluster, your machines, and native apps in your pocket.",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${ibmPlexMono.variable}`}>
      <body className="flex min-h-screen flex-col relative">
        <Header />
        <main className="flex-1 relative z-10">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
