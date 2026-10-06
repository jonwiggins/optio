export function isPodNotFound(err: unknown): boolean {
  const e = err as {
    code?: number;
    statusCode?: number;
    response?: { statusCode?: number; status?: number };
  } | null;
  return (
    e?.code === 404 ||
    e?.statusCode === 404 ||
    e?.response?.statusCode === 404 ||
    e?.response?.status === 404
  );
}
