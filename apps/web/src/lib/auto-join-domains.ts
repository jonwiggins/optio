/**
 * Sign-in auto-join domains, as typed in Workspace settings: "@Acme.com",
 * "https://acme.com/" and "acme.com" are all `acme.com`. Returns null for
 * something that isn't a domain. (Free-mail domains are refused by the API.)
 */
export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  d = d
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^.*@/, "")
    .replace(/\/.*$/, "");
  d = d.replace(/^\.+|\.+$/g, "");
  return /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d) ? d : null;
}

/** Add domains from a pasted list (commas / spaces), skipping invalid and duplicate ones. */
export function addDomains(
  current: string[],
  input: string,
): { domains: string[]; invalid: string[] } {
  const domains = [...current];
  const invalid: string[] = [];
  for (const part of input.split(/[\s,;]+/).filter(Boolean)) {
    const d = normalizeDomain(part);
    if (!d) invalid.push(part);
    else if (!domains.includes(d)) domains.push(d);
  }
  return { domains, invalid };
}
