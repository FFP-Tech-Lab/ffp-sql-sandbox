const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

/**
 * Private container DNS rewrite. Not part of the public API.
 * Allowlisting happens on the caller-supplied host before this is applied.
 */
export function rewriteLoopbackHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) ? 'host.docker.internal' : host.trim();
}
