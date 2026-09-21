export function streamMysqlQuery(
  query: {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  },
  connection: { destroy(): void },
  limiter: {
    push(values: unknown): {
      accept: boolean;
      truncated: boolean;
      reason?: string;
    };
  },
  writeEvent?: (event: { type: string; [key: string]: unknown }) => void,
): Promise<void>;

export function runMysqlQuery(
  conn: {
    connection: {
      query(opts: unknown): {
        on(event: string, listener: (...args: unknown[]) => void): unknown;
      };
      destroy(): void;
    };
  },
  sql: string,
  timeoutMs: number,
  limiter: {
    push(values: unknown): {
      accept: boolean;
      truncated: boolean;
      reason?: string;
    };
  },
  writeEvent?: (event: { type: string; [key: string]: unknown }) => void,
): Promise<void>;

export function closeMysqlConnection(conn: {
  end?: () => Promise<unknown> | unknown;
  destroy?: () => void;
}): Promise<void>;
