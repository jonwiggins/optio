import { readFileSync } from "node:fs";
import type { TlsOptions } from "node:tls";

/**
 * Parse SSL/TLS configuration from a PostgreSQL connection string.
 *
 * Reads `sslmode` and `sslrootcert` query parameters and returns
 * TLS options suitable for the postgres driver's `ssl` option.
 *
 * - absent / `disable` / `allow` → undefined (no SSL)
 * - `require` / `prefer`         → { rejectUnauthorized: false }
 * - `verify-ca` / `verify-full`  → { rejectUnauthorized: true, ca? }
 */
export function parseSslConfig(connStr: string): TlsOptions | undefined {
  let url: URL;
  try {
    url = new URL(connStr);
  } catch {
    return undefined;
  }

  const sslmode = url.searchParams.get("sslmode");
  if (!sslmode || sslmode === "disable" || sslmode === "allow") {
    return undefined;
  }

  if (sslmode === "verify-full" || sslmode === "verify-ca") {
    const sslrootcert = url.searchParams.get("sslrootcert");
    const opts: TlsOptions = { rejectUnauthorized: true };
    if (sslrootcert) {
      opts.ca = readFileSync(sslrootcert, "utf-8");
    }
    return opts;
  }

  // sslmode=require or sslmode=prefer — encrypted but no cert verification
  return { rejectUnauthorized: false };
}
