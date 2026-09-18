/**
 * Apply maxRows / maxBytes as rows arrive. Callers must stop producing
 * remaining rows when accept is false — do not buffer then truncate.
 */
export function createStreamLimiter({ maxRows, maxBytes }) {
  let rows = 0;
  let bytes = 0;
  let truncated = false;
  let reason;

  return {
    push(values) {
      if (truncated) {
        return { accept: false, truncated: true, reason };
      }
      const size = Buffer.byteLength(JSON.stringify(values), 'utf8');
      if (rows + 1 > maxRows) {
        truncated = true;
        reason = 'maxRows';
        return { accept: false, truncated: true, reason };
      }
      if (bytes + size > maxBytes) {
        truncated = true;
        reason = 'maxBytes';
        return { accept: false, truncated: true, reason };
      }
      rows += 1;
      bytes += size;
      return { accept: true, truncated: false };
    },
    get state() {
      return { rows, bytes, truncated, reason };
    },
  };
}
