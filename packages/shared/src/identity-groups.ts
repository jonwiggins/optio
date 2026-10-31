/** Membership group identifiers include their provider and trusted authority. */
export function qualifiedGroupParts(
  value: string,
): { provider: string; authority: string; name: string } | null {
  const match = /^sso:([a-z0-9-]+):([a-f0-9]{64}):(.+)$/i.exec(value);
  return match ? { provider: match[1], authority: match[2], name: match[3] } : null;
}

export function qualifiedGroupLabel(value: string): string {
  const group = qualifiedGroupParts(value);
  return group ? `${group.name} (${group.provider}, ${group.authority.slice(0, 8)})` : value;
}
