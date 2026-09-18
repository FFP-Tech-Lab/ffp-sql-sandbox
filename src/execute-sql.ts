import { validateSql } from './validate-sql.js';
import { hostIsAllowlisted } from './host-allowlist.js';
import { mergeLimits } from './limits.js';
import { DEFAULT_SANDBOX_IMAGE, isDigestPinnedImage } from './image.js';
import { rewriteLoopbackHost } from './rewrite-host.js';
import {
  createDefaultDocker,
  runInSandbox,
} from './docker-executor.js';
import type { DockerLike } from './docker-types.js';
import type {
  ExecuteSqlInput,
  ExecuteSqlResult,
  SqlDialect,
} from './types.js';

export type { ExecuteSqlInput, ExecuteSqlResult } from './types.js';
export type { DockerLike } from './docker-types.js';

export type ExecuteSqlDeps = {
  docker?: DockerLike;
};

export async function executeSql(
  input: ExecuteSqlInput,
  deps: ExecuteSqlDeps = {},
): Promise<ExecuteSqlResult> {
  const validation = validateSql(input.sql);
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      error: validation.reason,
    };
  }

  if (!hostIsAllowlisted(input.connection.host, input.hostAllowlist)) {
    return {
      ok: false,
      code: 'HOST_NOT_ALLOWED',
      error: `connection.host ${JSON.stringify(input.connection.host)} is not on hostAllowlist`,
    };
  }

  const dialect = parseDialect(input.connection.type);
  if (!dialect.ok) {
    return dialect;
  }

  const merged = mergeLimits(input.limits);
  if (!merged.ok) {
    return { ok: false, code: 'INVALID_LIMITS', error: merged.error };
  }

  const image = input.image ?? DEFAULT_SANDBOX_IMAGE;
  if (input.image === undefined && !isDigestPinnedImage(image)) {
    return {
      ok: false,
      code: 'IMAGE_UNPINNED',
      error: 'Default sandbox image must be pinned by sha256 digest',
    };
  }

  const docker = deps.docker ?? createDefaultDocker();
  try {
    await docker.ping();
  } catch (err) {
    return {
      ok: false,
      code: 'DOCKER_UNAVAILABLE',
      error: `Docker is required to execute SQL. Could not ping the Docker engine: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const dbHost = rewriteLoopbackHost(input.connection.host);
  const env = [
    `DB_TYPE=${dialect.type}`,
    `DB_HOST=${dbHost}`,
    `DB_PORT=${input.connection.port}`,
    `DB_USER=${input.connection.user}`,
    `DB_NAME=${input.connection.database}`,
    `QUERY_TIMEOUT=${merged.limits.timeoutMs}`,
    `MAX_ROWS=${merged.limits.maxRows}`,
    `MAX_BYTES=${merged.limits.maxBytes}`,
  ];

  return runInSandbox(docker, {
    image,
    usingDefaultImage: input.image === undefined,
    env,
    password: input.connection.password,
    stdinJson: JSON.stringify({ sql: input.sql }) + '\n',
    memoryBytes: merged.limits.memoryMb * 1024 * 1024,
    nanoCpus: merged.limits.nanoCpus,
    timeoutMs: merged.limits.timeoutMs,
    maxRows: merged.limits.maxRows,
    maxBytes: merged.limits.maxBytes,
  });
}

function parseDialect(
  type: SqlDialect,
): { ok: true; type: SqlDialect } | { ok: false; code: string; error: string } {
  switch (type) {
    case 'postgres':
    case 'mysql':
      return { ok: true, type };
    default: {
      const unexpected: never = type;
      return {
        ok: false,
        code: 'UNSUPPORTED_DIALECT',
        error: `Unsupported dialect: ${String(unexpected)}`,
      };
    }
  }
}
