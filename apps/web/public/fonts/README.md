# Vendored fonts

The web app's two families, served from here so a build needs no network
(`next/font/google` downloads them from Google Fonts at build time, which a
build with no internet access cannot reach). Set `OPTIO_OFFLINE_FONTS=1` at
build time to select `fonts-local.ts` and `next/font/local`; the default uses
Google Fonts. Both modules use the same CSS variables (`--font-sora`,
`--font-ibm-mono`).

| File                            | Family          | Weights | Subset |
| ------------------------------- | --------------- | ------- | ------ |
| `sora-latin-wght.woff2`         | Sora (variable) | 100–800 | latin  |
| `ibm-plex-mono-latin-400.woff2` | IBM Plex Mono   | 400     | latin  |
| `ibm-plex-mono-latin-500.woff2` | IBM Plex Mono   | 500     | latin  |
| `ibm-plex-mono-latin-600.woff2` | IBM Plex Mono   | 600     | latin  |

Downloaded from Google Fonts (fonts.gstatic.com: Sora v17, IBM Plex Mono
v20) on 2026-10-23. Both are under the SIL Open Font License 1.1 —
`Sora-OFL.txt`, `IBMPlexMono-OFL.txt`.
