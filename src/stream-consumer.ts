export type RunnerEvent =
  | { type: 'meta'; columns: string[] }
  | { type: 'row'; values: unknown[] }
  | { type: 'end'; truncated?: boolean; reason?: string }
  | { type: 'error'; error: string };

export type ConsumeLimits = {
  maxRows: number;
  maxBytes: number;
  abort: () => void;
};

export type ConsumeResult = {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  error?: string;
};

/**
 * Incrementally parse runner NDJSON from a live stream.
 * Limits are applied as chunks arrive — not after buffering the full result.
 */
export async function consumeNdjsonResult(
  stream: AsyncIterable<Buffer | string>,
  limits: ConsumeLimits,
): Promise<ConsumeResult> {
  const rows: unknown[][] = [];
  let columns: string[] = [];
  let truncated = false;
  let error: string | undefined;
  let bytes = 0;
  let lineBuf = '';
  let aborted = false;

  const abortOnce = (): void => {
    if (aborted) {
      return;
    }
    aborted = true;
    truncated = true;
    limits.abort();
  };

  try {
    for await (const chunk of stream) {
      if (aborted) {
        break;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.byteLength;
      if (bytes > limits.maxBytes) {
        abortOnce();
        break;
      }

      lineBuf += buf.toString('utf8');
      let newline = lineBuf.indexOf('\n');
      while (newline !== -1) {
        const line = lineBuf.slice(0, newline).trim();
        lineBuf = lineBuf.slice(newline + 1);
        if (line.length > 0) {
          const event = parseRunnerEvent(line);
          if (event) {
            switch (event.type) {
              case 'meta':
                columns = event.columns;
                break;
              case 'row':
                if (rows.length >= limits.maxRows) {
                  abortOnce();
                  break;
                }
                rows.push(event.values);
                if (rows.length >= limits.maxRows) {
                  abortOnce();
                }
                break;
              case 'end':
                if (event.truncated) {
                  truncated = true;
                }
                break;
              case 'error':
                error = event.error;
                break;
              default: {
                const _never: never = event;
                void _never;
                break;
              }
            }
          }
        }
        if (aborted) {
          break;
        }
        newline = lineBuf.indexOf('\n');
      }
      if (aborted) {
        break;
      }
    }
  } catch {
    // Stream destroy / abort is expected when limits fire.
  }

  const result: ConsumeResult = { columns, rows, truncated };
  if (error !== undefined) {
    result.error = error;
  }
  return result;
}

function parseRunnerEvent(line: string): RunnerEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || !('type' in parsed)) {
    return null;
  }
  const record = parsed as { type: unknown };
  switch (record.type) {
    case 'meta': {
      const columns = (parsed as { columns?: unknown }).columns;
      if (!Array.isArray(columns) || !columns.every((c) => typeof c === 'string')) {
        return null;
      }
      return { type: 'meta', columns };
    }
    case 'row': {
      const values = (parsed as { values?: unknown }).values;
      if (!Array.isArray(values)) {
        return null;
      }
      return { type: 'row', values };
    }
    case 'end': {
      const truncated = (parsed as { truncated?: unknown }).truncated;
      const reason = (parsed as { reason?: unknown }).reason;
      const event: RunnerEvent = { type: 'end' };
      if (typeof truncated === 'boolean') {
        event.truncated = truncated;
      }
      if (typeof reason === 'string') {
        event.reason = reason;
      }
      return event;
    }
    case 'error': {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error !== 'string') {
        return null;
      }
      return { type: 'error', error };
    }
    default:
      return null;
  }
}
