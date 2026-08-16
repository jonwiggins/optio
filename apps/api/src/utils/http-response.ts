const TRUNCATED_SUFFIX = "...(truncated)";

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + TRUNCATED_SUFFIX : text;
}

/**
 * Read at most `maxBytes` from an untrusted response body.
 *
 * This avoids buffering arbitrarily large webhook/slack responses in memory
 * only to truncate them afterwards.
 */
export async function readLimitedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    if (!response.body) {
      return truncateText(await response.text(), maxBytes);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }

      const nextTotal = totalBytes + value.byteLength;
      if (nextTotal > maxBytes) {
        const allowed = Math.max(maxBytes - totalBytes, 0);
        if (allowed > 0) {
          text += decoder.decode(value.slice(0, allowed), { stream: true });
        }
        text += decoder.decode();
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      totalBytes = nextTotal;
      text += decoder.decode(value, { stream: true });
    }

    return truncated ? text + TRUNCATED_SUFFIX : text;
  } catch {
    return undefined;
  }
}
