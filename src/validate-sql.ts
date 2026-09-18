const ALLOWED_PREFIX = /^\s*(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i;

const FORBIDDEN_KEYWORD =
  /\b(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|EXECUTE|xp_)\b/i;

const MULTI_STATEMENT = /;\s*\S/;

const PREFIX_REASON =
  'Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN statements are allowed';

export function validateSql(
  sql: string,
): { ok: true } | { ok: false; code: string; reason: string } {
  const trimmed = sql.trim();

  if (!ALLOWED_PREFIX.test(trimmed)) {
    return {
      ok: false,
      code: 'NOT_READ_ONLY_PREFIX',
      reason: PREFIX_REASON,
    };
  }

  if (FORBIDDEN_KEYWORD.test(trimmed)) {
    return {
      ok: false,
      code: 'FORBIDDEN_KEYWORD',
      reason: 'Forbidden SQL keyword detected',
    };
  }

  if (MULTI_STATEMENT.test(trimmed)) {
    return {
      ok: false,
      code: 'MULTI_STATEMENT',
      reason: 'Multi-statement SQL is not allowed',
    };
  }

  return { ok: true };
}
