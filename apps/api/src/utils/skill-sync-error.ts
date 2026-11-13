/** Git failures can echo credentials from the command's source URL. */
export function redactSkillSource(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@")
    .replace(/([?&](?:access_token|token|password|secret|key|auth)=)[^\s&#'")]*/gi, "$1[redacted]");
}

export function formatSkillSyncError(error: unknown, stage: string, sourceUrl: string): string {
  const err = error as { stderr?: unknown; killed?: boolean; code?: unknown } | null;
  // Prefer stderr to Node's message, which includes the whole command and URL.
  let detail =
    typeof err?.stderr === "string" && err.stderr.trim()
      ? err.stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);
  // Also remove individual credential values if git prints them separately.
  try {
    const url = new URL(sourceUrl);
    const credentials = [
      url.username,
      url.password,
      ...Array.from(url.searchParams.entries())
        .filter(([key]) => /^(access_token|token|password|secret|key|auth)$/i.test(key))
        .map(([, value]) => value),
    ];
    for (const value of credentials.filter(Boolean)) {
      for (const secret of new Set([value, decodeURIComponent(value)])) {
        detail = detail.split(secret).join("[redacted]");
      }
    }
  } catch {
    /* SCP-style SSH sources aren't URLs. */
  }
  detail = redactSkillSource(detail).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  let summary = `Could not ${stage}.`;
  if (err?.killed || err?.code === "ETIMEDOUT") {
    summary += " Git timed out; check connectivity to the repository and try again.";
  } else if (
    /authentication failed|could not read (?:Username|Password)|terminal prompts disabled|permission denied \(publickey\)|access denied|invalid username or (?:password|token)/i.test(
      detail,
    )
  ) {
    summary +=
      " Git authentication failed. Check the source credentials and repository access; interactive sign-in is disabled.";
  } else if (/repository .*not found|repository not found/i.test(detail)) {
    summary +=
      " Check the repository URL and access permissions. A private repository may appear missing when credentials are absent or invalid.";
  }
  const limit = 4000;
  return `${summary}\n${detail.length > limit ? detail.slice(0, limit) + "\n[truncated]" : detail}`;
}
