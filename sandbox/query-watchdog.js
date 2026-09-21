export function queryTimeoutError(timeoutMs) {
  const err = new Error(`QUERY_TIMEOUT after ${timeoutMs}ms`);
  err.code = 'QUERY_TIMEOUT';
  return err;
}

export function isQueryTimeoutError(err) {
  if (err === null || err === undefined) {
    return false;
  }
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String(err.code)
      : '';
  if (code === 'QUERY_TIMEOUT' || code === 'ER_QUERY_TIMEOUT') {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return (
    /QUERY_TIMEOUT/i.test(message) ||
    /statement timeout/i.test(message) ||
    /max_execution_time/i.test(message) ||
    /query execution was interrupted/i.test(message)
  );
}

export function startQueryWatchdog(timeoutMs, onTimeout) {
  const timer = setTimeout(() => {
    onTimeout(queryTimeoutError(timeoutMs));
  }, timeoutMs);
  return () => clearTimeout(timer);
}
