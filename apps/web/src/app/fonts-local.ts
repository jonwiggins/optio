import localFont from "next/font/local";

// Vendored under public/fonts (Google Fonts' latin files, OFL): a build with
// no internet access can't download them the way next/font/google does.
export const sora = localFont({
  src: "../../public/fonts/sora-latin-wght.woff2",
  weight: "100 800",
  style: "normal",
  display: "swap",
  variable: "--font-sora",
});

export const ibmPlexMono = localFont({
  src: [
    { path: "../../public/fonts/ibm-plex-mono-latin-400.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/ibm-plex-mono-latin-500.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/ibm-plex-mono-latin-600.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  variable: "--font-ibm-mono",
});
