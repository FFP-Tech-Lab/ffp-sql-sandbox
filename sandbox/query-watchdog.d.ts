export function queryTimeoutError(timeoutMs: number): Error & { code: string };
export function isQueryTimeoutError(err: unknown): boolean;
export function startQueryWatchdog(
  timeoutMs: number,
  onTimeout: (err: Error) => void,
): () => void;
