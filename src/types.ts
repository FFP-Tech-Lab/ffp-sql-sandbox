export type SqlDialect = 'postgres' | 'mysql';

export type SandboxLimits = {
  timeoutMs: number;
  memoryMb: number;
  nanoCpus: number;
  maxRows: number;
  maxBytes: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 10_000,
  memoryMb: 128,
  nanoCpus: 500_000_000,
  maxRows: 1_000,
  maxBytes: 1_000_000,
};

export type SandboxConnection = {
  type: SqlDialect;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export type ValidateSqlSuccess = { ok: true };
export type ValidateSqlFailure = { ok: false; code: string; reason: string };
export type ValidateSqlResult = ValidateSqlSuccess | ValidateSqlFailure;

export type ExecuteSqlInput = {
  sql: string;
  connection: SandboxConnection;
  hostAllowlist: string[];
  limits?: Partial<SandboxLimits>;
  /** Custom runner image. Treated as untrusted; the default image is digest-pinned. */
  image?: string;
};

export type QueryResultData = {
  columns: string[];
  rows: unknown[][];
  truncated?: boolean;
};

export type ExecuteSqlSuccess = { ok: true; data: QueryResultData };
export type ExecuteSqlFailure = { ok: false; code: string; error: string };
export type ExecuteSqlResult = ExecuteSqlSuccess | ExecuteSqlFailure;
