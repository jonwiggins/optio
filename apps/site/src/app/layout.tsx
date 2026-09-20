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
  title: {
    default: "Optio — Self-Hosted AI Agent Swarm & Workflow Orchestration",
    template: "%s | Optio",
  },
  description:
    "Run AI agents as sessions on your Kubernetes cluster or your own machines: ticket-to-merged-PR pipelines, scheduled and webhook-driven jobs, event automations, interactive terminals, and persistent multi-agent systems. Open source, self-hosted, multi-vendor.",
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Optio",
    title: "Optio — Self-Hosted AI Agent Swarm & Workflow Orchestration",
    description:
      "Self-hosted orchestration for AI agent sessions and swarms — PR pipelines, jobs, automations, terminals, and persistent agents on your cluster or your laptop.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Optio — Self-Hosted AI Agent Swarm & Workflow Orchestration",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Optio — Self-Hosted AI Agent Swarm & Workflow Orchestration",
    description:
      "Self-hosted orchestration for AI agent sessions and swarms — PR pipelines, jobs, automations, terminals, and persistent agents on your cluster or your laptop.",
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
