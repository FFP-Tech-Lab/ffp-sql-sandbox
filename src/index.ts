import { executeSql as executeSqlWithDeps } from './execute-sql.js';
import type { ExecuteSqlInput, ExecuteSqlResult } from './types.js';

export { validateSql } from './validate-sql.js';
export { DEFAULT_SANDBOX_IMAGE } from './image.js';
export { DEFAULT_SANDBOX_LIMITS } from './types.js';
export type {
  ExecuteSqlFailure,
  ExecuteSqlInput,
  ExecuteSqlResult,
  ExecuteSqlSuccess,
  QueryResultData,
  SandboxConnection,
  SandboxLimits,
  SqlDialect,
  ValidateSqlFailure,
  ValidateSqlResult,
  ValidateSqlSuccess,
} from './types.js';

/** Public executeSql: Docker client injection is not part of the supported API. */
export function executeSql(input: ExecuteSqlInput): Promise<ExecuteSqlResult> {
  return executeSqlWithDeps(input);
}
