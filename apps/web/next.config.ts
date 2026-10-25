import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Browser tests can run alongside a developer server without sharing chunks.
  distDir: process.env.OPTIO_NEXT_DIST_DIR || ".next",
  transpilePackages: ["@optio/shared"],
  webpack: (config, { webpack }) => {
    if (process.env.OPTIO_OFFLINE_FONTS === "1") {
      // Next's tsconfig paths plugin resolves @/app/fonts before aliases.
      // Replace the resolved module so an offline build never loads Google fonts.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /[\\/]src[\\/]app[\\/]fonts\.ts$/,
          (data: { createData?: { resource?: string } }) => {
            if (data.createData?.resource) {
              data.createData.resource = data.createData.resource.replace(
                /fonts\.ts$/,
                "fonts-local.ts",
              );
            }
          },
        ),
      );
    }
    // Resolve .js imports to .ts files in workspace packages
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    // xterm.js decides it runs under Node when a `process` object with a
    // `title` exists, and webpack injects Next's browser `process` polyfill
    // ({ title: "browser" }) into every module that mentions `process`. That
    // turns off every Mac rule in the terminal: ⌥↑/⌥↓ go out as Ctrl+↑/↓ (so
    // Codex's "answer the question" key never arrives), ⌥←/→ lose their word
    // jumps, and Option-typed characters arrive as Esc+letter. The prebuilt
    // bundle imports nothing, so include it unparsed: no polyfill, and xterm
    // sees the real browser. (Fixed upstream after @xterm/xterm 6.0.) The WebGL
    // renderer addon carries its own copy of the same platform check.
    const noParse = config.module.noParse;
    config.module.noParse = [
      ...(noParse ? (Array.isArray(noParse) ? noParse : [noParse]) : []),
      /[\\/]@xterm[\\/]xterm[\\/]lib[\\/]xterm\.js$/,
      /[\\/]@xterm[\\/]addon-webgl[\\/]lib[\\/]addon-webgl\.js$/,
    ];
    return config;
  },
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    const baseHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(self), geolocation=()",
      },
      {
        key: "Content-Security-Policy-Report-Only",
        value: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "connect-src 'self' wss: ws:",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "frame-ancestors 'none'",
        ].join("; "),
      },
    ];
    if (isProd) {
      baseHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains; preload",
      });
    }
    return [
      {
        source: "/(.*)",
        headers: baseHeaders,
      },
    ];
  },
};

export default nextConfig;
