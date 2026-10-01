/** A Postgres unique violation — drizzle wraps it ("Failed query: …"), so the code is on a `cause`. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
}
