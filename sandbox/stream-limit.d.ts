export function createStreamLimiter(opts: {
  maxRows: number;
  maxBytes: number;
}): {
  push(values: unknown): {
    accept: boolean;
    truncated: boolean;
    reason?: string;
  };
  readonly state: {
    rows: number;
    bytes: number;
    truncated: boolean;
    reason?: string;
  };
};
