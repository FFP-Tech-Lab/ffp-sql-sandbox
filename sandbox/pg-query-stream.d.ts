export function streamPgQuery(
  query: {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  },
  client: {
    query(query: unknown): unknown;
    connection?: { stream?: { destroy?: () => void } };
  },
  limiter: {
    push(values: unknown): {
      accept: boolean;
      truncated: boolean;
      reason?: string;
    };
  },
  writeEvent?: (event: { type: string; [key: string]: unknown }) => void,
): Promise<void>;
