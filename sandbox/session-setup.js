export function sessionSetupStatements(type, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1_000_000_000) {
    throw new Error('timeoutMs must be a positive integer');
  }

  switch (type) {
    case 'postgres':
      return [
        'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY',
        `SET statement_timeout = ${timeoutMs}`,
      ];
    case 'mysql':
      return [
        'SET SESSION TRANSACTION READ ONLY',
        `SET SESSION MAX_EXECUTION_TIME = ${timeoutMs}`,
      ];
    default:
      throw new Error(`unsupported dialect: ${type}`);
  }
}
