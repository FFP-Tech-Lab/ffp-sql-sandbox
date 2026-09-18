export function hostIsAllowlisted(
  host: string,
  hostAllowlist: string[],
): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  const allowed = new Set(
    hostAllowlist.map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );
  return allowed.has(normalized);
}
