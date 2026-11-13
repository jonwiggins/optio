/** Visible summary plus keyboard/touch-accessible Git diagnostics. */
export function SkillSyncError({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  const lines = error.split("\n");
  const formatted = lines[0].startsWith("Could not ");
  return (
    <div className="mt-2 text-xs text-error break-words" role="alert">
      <p>{formatted ? lines[0] : "Skill sync failed. See the details below for the cause."}</p>
      <details className="mt-1">
        <summary className="cursor-pointer">Sync error details</summary>
        <pre className="mt-1 whitespace-pre-wrap break-all select-text font-mono">
          {formatted ? lines.slice(1).join("\n") : error}
        </pre>
      </details>
    </div>
  );
}
