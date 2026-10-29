import { Sora, IBM_Plex_Mono } from "next/font/google";

export const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
});

export const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm-mono",
});
