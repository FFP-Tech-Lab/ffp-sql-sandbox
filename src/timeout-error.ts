export function isTimeoutError(error: string | undefined): boolean {
  if (error === undefined || error === '') {
    return false;
  }
  return (
    /QUERY_TIMEOUT/i.test(error) ||
    /statement timeout/i.test(error) ||
    /max_execution_time/i.test(error) ||
    /query execution was interrupted/i.test(error)
  );
}
